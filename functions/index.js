const crypto = require('crypto');
const admin = require('firebase-admin');
const functions = require('firebase-functions');

admin.initializeApp();

const db = admin.database();
const AUTHORIZED_ADMIN_EMAILS = new Set(['sarobidytyph4@gmail.com']);
const DEFAULT_WHEEL_LOTS = [
  { id: 'L1', nom: '10 $ Gratuit', type: 'crypto', probabilite: 0 },
  { id: 'L2', nom: 'Frais de gaz - 0.00004 BNB', type: 'crypto', probabilite: 10 },
  { id: 'L3', nom: 'Crédit 500 Ar', type: 'fiat', probabilite: 1 },
  { id: 'L4', nom: '0.2 TON', type: 'crypto', probabilite: 2 },
  { id: 'L5', nom: 'Merci de votre fidélité', type: 'rien', probabilite: 87 }
];
const RATE_PAIRS = {
  USDT: 'USDTUSDT',
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  BNB: 'BNBUSDT',
  LTC: 'LTCUSDT',
  SOL: 'SOLUSDT',
  TRX: 'TRXUSDT',
  DOGE: 'DOGEUSDT',
  MATIC: 'POLUSDT',
  SUI: 'SUIUSDT',
  XRP: 'XRPUSDT',
  TON: 'TONUSDT',
  POL: 'POLUSDT',
  USDC: 'USDCUSDT'
};

function assertAuthenticated(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentification requise.');
  }
  return context.auth.uid;
}

function assertAdmin(context) {
  const uid = assertAuthenticated(context);
  const email = String(context.auth.token.email || '').toLowerCase();
  if (!AUTHORIZED_ADMIN_EMAILS.has(email)) {
    throw new functions.https.HttpsError('permission-denied', 'Accès administrateur requis.');
  }
  return { uid, email };
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateSaltHex() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPin(pin, salt) {
  return sha256Hex(`${pin}${salt}`);
}

function generateStableId(email, seed) {
  const raw = Buffer.from(`${email}${seed}`).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  return `TX-${raw}-${Date.now().toString(36)}`;
}

function getIsoDayBounds() {
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function normalizeWheelLots(rawLots) {
  const source = Array.isArray(rawLots) ? rawLots : (rawLots ? Object.values(rawLots) : []);
  const filtered = source.filter(Boolean);
  return filtered.length > 0 ? filtered : DEFAULT_WHEEL_LOTS;
}

async function loadUser(uid) {
  const snapshot = await db.ref(`donnees/utilisateurs/${uid}`).once('value');
  if (!snapshot.exists()) {
    throw new functions.https.HttpsError('not-found', 'Utilisateur introuvable.');
  }
  return snapshot.val();
}

async function loadSecurePin(uid) {
  const snapshot = await db.ref(`donnees/securePins/${uid}`).once('value');
  return snapshot.val() || null;
}

async function createArchivedTransactionIfNeeded(transaction) {
  if (transaction.statut !== 'confirme') return;
  await db.ref(`donnees/archives/${transaction.id}`).set({
    ...transaction,
    archivedAt: new Date().toISOString()
  });
}

async function publishRates(source = 'scheduled') {
  const rateResponse = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
  const rateData = await rateResponse.json();
  const usdMGA = rateData?.rates?.MGA || 4700;

  const tickerResponse = await fetch('https://api.binance.com/api/v3/ticker/price');
  const prices = await tickerResponse.json();

  const currentRatesSnapshot = await db.ref('donnees/taux').once('value');
  const currentRates = currentRatesSnapshot.val() || {};
  const updates = {
    'donnees/usdMGA': usdMGA
  };

  Object.entries(RATE_PAIRS).forEach(([cryptoCode, pair]) => {
    if (cryptoCode === 'USDT') {
      updates[`donnees/taux/${cryptoCode}`] = {
        prixUSD: 1,
        prixMGA: usdMGA,
        variation: '0.00',
        couleur: 'positive',
        lastUpdate: new Date().toISOString(),
        source
      };
      return;
    }

    const ticker = prices.find((item) => item.symbol === pair);
    if (!ticker) return;

    const prixUSD = Number.parseFloat(ticker.price);
    const prixMGA = Math.round(prixUSD * usdMGA);
    const precedent = Number(currentRates?.[cryptoCode]?.prixUSD || prixUSD);
    const variationRaw = precedent ? ((prixUSD - precedent) / precedent) * 100 : 0;
    const variation = Number.isFinite(variationRaw) ? variationRaw : 0;

    updates[`donnees/taux/${cryptoCode}`] = {
      prixUSD,
      prixMGA,
      variation: `${variation > 0 ? '+' : ''}${variation.toFixed(2)}`,
      couleur: variation >= 0 ? 'positive' : 'negative',
      lastUpdate: new Date().toISOString(),
      source
    };
  });

  await db.ref().update(updates);
  return updates;
}

exports.syncRates = functions.region('us-central1').https.onCall(async (_, context) => {
  assertAdmin(context);
  await publishRates('manual');
  return { success: true };
});

exports.ensureUserProfile = functions.region('us-central1').https.onCall(async (data, context) => {
  const uid = assertAuthenticated(context);
  const email = context.auth.token.email || '';
  const displayName = String(data?.displayName || context.auth.token.name || email.split('@')[0] || 'Utilisateur').trim();
  let referralUid = String(data?.referralUid || '').trim();
  const referralCode = String(data?.referralCode || '').trim();
  if (!referralUid && referralCode) {
    if (/^[A-Za-z0-9_-]{20,}$/.test(referralCode)) {
      const directSnapshot = await db.ref(`donnees/utilisateurs/${referralCode}`).once('value');
      if (directSnapshot.exists()) referralUid = referralCode;
    }
    if (!referralUid) {
      const referralSnapshot = await db.ref('donnees/utilisateurs').orderByChild('id').equalTo(referralCode).limitToFirst(1).once('value');
      const referralData = referralSnapshot.val();
      if (referralData) referralUid = Object.keys(referralData)[0];
    }
  }
  const userRef = db.ref(`donnees/utilisateurs/${uid}`);
  const snapshot = await userRef.once('value');
  if (snapshot.exists()) {
    const existing = snapshot.val();
    if (existing.codePIN?.hash || existing.codePIN?.salt) {
      await db.ref(`donnees/securePins/${uid}`).set({
        hash: existing.codePIN.hash || null,
        salt: existing.codePIN.salt || null,
        updatedAt: new Date().toISOString()
      });
      existing.codePIN = {
        actif: !!existing.codePIN.actif,
        tentativeEchouees: Number(existing.codePIN.tentativeEchouees || 0),
        bloque: !!existing.codePIN.bloque,
        updatedAt: new Date().toISOString()
      };
      await userRef.child('codePIN').set(existing.codePIN);
    }
    return { success: true, profile: existing, created: false };
  }

  const profile = {
    id: generateStableId(email, displayName),
    nom: displayName,
    email,
    dateInscription: new Date().toISOString(),
    numeros: {},
    adressesLiees: {},
    codePIN: { actif: false, tentativeEchouees: 0, bloque: false },
    toursGratuits: 0,
    filleulsCount: 0,
    parrainId: referralUid || '',
    bonusParrainageDonne: false
  };

  await userRef.set(profile);
  return { success: true, profile, created: true };
});

exports.scheduledSyncRates = functions.region('us-central1').pubsub.schedule('every 30 minutes').onRun(async () => {
  await publishRates('scheduled');
  return null;
});

exports.setPin = functions.region('us-central1').https.onCall(async (data, context) => {
  const uid = assertAuthenticated(context);
  const pin = String(data?.pin || '');
  if (!/^\d{6}$/.test(pin)) {
    throw new functions.https.HttpsError('invalid-argument', 'Le code PIN doit contenir 6 chiffres.');
  }

  const salt = generateSaltHex();
  const hash = hashPin(pin, salt);
  const securePin = {
    hash,
    salt,
    updatedAt: new Date().toISOString()
  };
  const pinState = {
    actif: true,
    tentativeEchouees: 0,
    bloque: false,
    updatedAt: new Date().toISOString()
  };

  await db.ref(`donnees/securePins/${uid}`).set(securePin);
  await db.ref(`donnees/utilisateurs/${uid}/codePIN`).set(pinState);
  return {
    success: true,
    codePIN: {
      actif: true,
      tentativeEchouees: 0,
      bloque: false
    }
  };
});

exports.resetPin = functions.region('us-central1').https.onCall(async (_, context) => {
  const uid = assertAuthenticated(context);
  await db.ref(`donnees/securePins/${uid}`).remove();
  const pinState = {
    actif: false,
    tentativeEchouees: 0,
    bloque: false,
    updatedAt: new Date().toISOString()
  };
  await db.ref(`donnees/utilisateurs/${uid}/codePIN`).set(pinState);
  return { success: true, codePIN: pinState };
});

exports.submitTransaction = functions.region('us-central1').https.onCall(async (data, context) => {
  const uid = assertAuthenticated(context);
  const pin = String(data?.pin || '');
  const transaction = data?.transaction || null;

  if (!/^\d{6}$/.test(pin) || !transaction || !transaction.type) {
    throw new functions.https.HttpsError('invalid-argument', 'Transaction invalide.');
  }

  const user = await loadUser(uid);
  const pinState = user.codePIN || {};
  const securePin = await loadSecurePin(uid);
  if (!pinState.actif || !securePin?.hash || !securePin?.salt) {
    throw new functions.https.HttpsError('failed-precondition', 'Code PIN non configuré.');
  }
  if (pinState.bloque) {
    throw new functions.https.HttpsError('permission-denied', 'Code PIN bloqué.');
  }

  const candidateHash = hashPin(pin, securePin.salt);
  if (candidateHash !== securePin.hash) {
    const attempts = Number(pinState.tentativeEchouees || 0) + 1;
    const blocked = attempts >= 3;
    await db.ref(`donnees/utilisateurs/${uid}/codePIN`).update({
      tentativeEchouees: attempts,
      bloque: blocked,
      updatedAt: new Date().toISOString()
    });
    throw new functions.https.HttpsError('permission-denied', blocked ? 'Code PIN bloqué.' : `Code PIN incorrect. Tentatives restantes: ${3 - attempts}`);
  }

  const id = generateStableId(user.email, Date.now().toString());
  const demande = {
    id,
    type: transaction.type,
    date: new Date().toISOString(),
    utilisateur: user.nom,
    email: user.email,
    userID: uid,
    statut: 'en_attente',
    txid: transaction.txid || '',
    lastModified: Date.now(),
    ...transaction
  };

  await db.ref(`donnees/demandes/${id}`).set(demande);
  await db.ref(`donnees/utilisateurs/${uid}/codePIN`).update({
    tentativeEchouees: 0,
    bloque: false,
    updatedAt: new Date().toISOString()
  });

  return {
    success: true,
    transaction: demande,
    codePIN: {
      actif: true,
      tentativeEchouees: 0,
      bloque: false
    }
  };
});

exports.migrateLegacyPin = functions.region('us-central1').https.onCall(async (_, context) => {
  const uid = assertAuthenticated(context);
  const user = await loadUser(uid);
  if (!user.codePIN?.hash && !user.codePIN?.salt) {
    return { success: true, migrated: false };
  }

  await db.ref(`donnees/securePins/${uid}`).set({
    hash: user.codePIN.hash || null,
    salt: user.codePIN.salt || null,
    updatedAt: new Date().toISOString()
  });
  const metadata = {
    actif: !!user.codePIN.actif,
    tentativeEchouees: Number(user.codePIN.tentativeEchouees || 0),
    bloque: !!user.codePIN.bloque,
    updatedAt: new Date().toISOString()
  };
  await db.ref(`donnees/utilisateurs/${uid}/codePIN`).set(metadata);
  return { success: true, migrated: true, codePIN: metadata };
});

exports.playWheel = functions.region('us-central1').https.onCall(async (_, context) => {
  const uid = assertAuthenticated(context);
  const user = await loadUser(uid);
  const demandesSnapshot = await db.ref('donnees/demandes').orderByChild('userID').equalTo(uid).once('value');
  const demandes = Object.values(demandesSnapshot.val() || {});
  const { start, end } = getIsoDayBounds();

  const confirmedToday = demandes.some((item) =>
    (item.type === 'ACHAT' || item.type === 'VENTE') &&
    item.statut === 'confirme' &&
    item.date >= start &&
    item.date < end
  );
  const playedToday = demandes.some((item) =>
    item.type === 'BONUS' &&
    item.date >= start &&
    item.date < end
  );

  let toursGratuits = Number(user.toursGratuits || 0);
  const usingFreeTurn = toursGratuits > 0;

  if (!confirmedToday && !usingFreeTurn) {
    throw new functions.https.HttpsError('failed-precondition', 'Une transaction confirmée aujourd’hui ou un tour gratuit est requis.');
  }
  if (playedToday && !usingFreeTurn) {
    throw new functions.https.HttpsError('failed-precondition', 'Vous avez déjà joué aujourd’hui.');
  }

  const wheelSnapshot = await db.ref('donnees/roue').once('value');
  const lots = normalizeWheelLots(wheelSnapshot.val());
  const rand = Math.random() * 100;
  let running = 0;
  let index = lots.length - 1;
  for (let i = 0; i < lots.length; i += 1) {
    running += Number.parseFloat(lots[i].probabilite) || 0;
    if (rand <= running) {
      index = i;
      break;
    }
  }

  const lot = lots[index];
  if (usingFreeTurn) {
    toursGratuits -= 1;
    await db.ref(`donnees/utilisateurs/${uid}/toursGratuits`).set(toursGratuits);
  }

  const lose = lot.type === 'rien' || String(lot.nom || '').toLowerCase().includes('merci') || String(lot.nom || '').toLowerCase().includes('retentez');
  if (lose) {
    const demande = {
      id: generateStableId(user.email, `LOSE-${Date.now()}`),
      type: 'BONUS',
      date: new Date().toISOString(),
      utilisateur: user.nom,
      email: user.email,
      userID: uid,
      statut: 'rejete',
      lotGagne: lot.nom,
      montant: '0',
      notes: 'Tentative de bonus - pas de gain',
      lastModified: Date.now()
    };
    await db.ref(`donnees/demandes/${demande.id}`).set(demande);
    return { success: true, result: 'lose', lot, index, toursGratuits };
  }

  await db.ref(`donnees/utilisateurs/${uid}/wheelState/currentPlay`).set({
    lot,
    index,
    createdAt: new Date().toISOString(),
    claimed: false
  });

  return { success: true, result: 'win', lot, index, toursGratuits };
});

exports.claimWheelBonus = functions.region('us-central1').https.onCall(async (data, context) => {
  const uid = assertAuthenticated(context);
  const user = await loadUser(uid);
  const contact = String(data?.contact || '').trim();
  if (!contact) {
    throw new functions.https.HttpsError('invalid-argument', 'Information de réception requise.');
  }

  const playRef = db.ref(`donnees/utilisateurs/${uid}/wheelState/currentPlay`);
  const playSnapshot = await playRef.once('value');
  if (!playSnapshot.exists()) {
    throw new functions.https.HttpsError('failed-precondition', 'Aucun gain à réclamer.');
  }

  const currentPlay = playSnapshot.val();
  if (currentPlay.claimed || !currentPlay.lot) {
    throw new functions.https.HttpsError('failed-precondition', 'Ce gain a déjà été traité.');
  }

  const demande = {
    id: generateStableId(user.email, `BONUS-${Date.now()}`),
    type: 'BONUS',
    date: new Date().toISOString(),
    utilisateur: user.nom,
    email: user.email,
    userID: uid,
    statut: 'en_attente',
    lotGagne: currentPlay.lot.nom,
    montant: currentPlay.lot.nom,
    adresse: contact,
    txid: `ROUE-${Date.now().toString().slice(-8)}`,
    lastModified: Date.now()
  };

  await db.ref(`donnees/demandes/${demande.id}`).set(demande);
  await playRef.remove();
  return { success: true, transaction: demande };
});

exports.adminUpdateTransactionStatus = functions.region('us-central1').https.onCall(async (data, context) => {
  const adminInfo = assertAdmin(context);
  const id = String(data?.id || '').trim();
  const status = String(data?.status || '').trim();
  const note = String(data?.note || '').trim();
  const allowedStatuses = new Set(['en_attente', 'confirme', 'rejete']);
  if (!id || !allowedStatuses.has(status)) {
    throw new functions.https.HttpsError('invalid-argument', 'Paramètres de statut invalides.');
  }

  const ref = db.ref(`donnees/demandes/${id}`);
  const snapshot = await ref.once('value');
  if (!snapshot.exists()) {
    throw new functions.https.HttpsError('not-found', 'Transaction introuvable.');
  }

  const transaction = snapshot.val();
  const previousStatus = transaction.statut;
  const historique = Array.isArray(transaction.historique) ? transaction.historique : [];
  historique.push({
    date: new Date().toISOString(),
    action: 'STATUT_CHANGE',
    details: `Statut changé de ${previousStatus} à ${status} par admin`,
    admin: adminInfo.email
  });
  if (note) {
    historique.push({
      date: new Date().toISOString(),
      action: 'NOTE_ADMIN',
      details: note,
      admin: adminInfo.email
    });
  }

  const updated = {
    ...transaction,
    statut: status,
    dateModification: new Date().toISOString(),
    lastModified: Date.now(),
    lastModifiedBy: adminInfo.email,
    historique
  };

  await ref.set(updated);
  await createArchivedTransactionIfNeeded(updated);
  return { success: true, transaction: updated };
});

exports.adminApproveNumber = functions.region('us-central1').https.onCall(async (data, context) => {
  assertAdmin(context);
  const uid = String(data?.uid || '').trim();
  const numeroId = String(data?.numeroId || '').trim();
  if (!uid || !numeroId) {
    throw new functions.https.HttpsError('invalid-argument', 'Paramètres manquants.');
  }

  await db.ref(`donnees/utilisateurs/${uid}/numeros/${numeroId}/statut`).set('approuve');
  const user = await loadUser(uid);
  let referralAwarded = false;
  if (user.parrainId && !user.bonusParrainageDonne) {
    const sponsorRef = db.ref(`donnees/utilisateurs/${user.parrainId}`);
    const sponsorSnapshot = await sponsorRef.once('value');
    if (sponsorSnapshot.exists()) {
      const sponsor = sponsorSnapshot.val();
      await sponsorRef.update({
        toursGratuits: Number(sponsor.toursGratuits || 0) + 1,
        filleulsCount: Number(sponsor.filleulsCount || 0) + 1
      });
      await db.ref(`donnees/utilisateurs/${uid}/bonusParrainageDonne`).set(true);
      referralAwarded = true;
    }
  }

  return { success: true, referralAwarded };
});

exports.adminRejectNumber = functions.region('us-central1').https.onCall(async (data, context) => {
  assertAdmin(context);
  const uid = String(data?.uid || '').trim();
  const numeroId = String(data?.numeroId || '').trim();
  if (!uid || !numeroId) {
    throw new functions.https.HttpsError('invalid-argument', 'Paramètres manquants.');
  }
  await db.ref(`donnees/utilisateurs/${uid}/numeros/${numeroId}/statut`).set('rejete');
  return { success: true };
});

exports.adminBackfillReferralBonuses = functions.region('us-central1').https.onCall(async (_, context) => {
  assertAdmin(context);
  const usersSnapshot = await db.ref('donnees/utilisateurs').once('value');
  const users = usersSnapshot.val() || {};
  let awarded = 0;

  for (const [uid, user] of Object.entries(users)) {
    if (!user.parrainId || user.bonusParrainageDonne) continue;
    const hasApprovedNumber = Object.values(user.numeros || {}).some((numero) => numero.statut === 'approuve');
    if (!hasApprovedNumber) continue;

    const sponsorRef = db.ref(`donnees/utilisateurs/${user.parrainId}`);
    const sponsorSnapshot = await sponsorRef.once('value');
    if (!sponsorSnapshot.exists()) continue;

    const sponsor = sponsorSnapshot.val();
    await sponsorRef.update({
      toursGratuits: Number(sponsor.toursGratuits || 0) + 1,
      filleulsCount: Number(sponsor.filleulsCount || 0) + 1
    });
    await db.ref(`donnees/utilisateurs/${uid}/bonusParrainageDonne`).set(true);
    awarded += 1;
  }

  return { success: true, awarded };
});
