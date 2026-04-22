if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('/sw.js').then(reg => {
                    console.log('Service Worker registered');
                }).catch(err => {
                    console.log('Service Worker failed');
                });
            });
        }

        // ==================== VÉRIFICATION DES MISES À JOUR ====================
        async function verifierMiseAJour() {
            try {
                const response = await fetch('/version.json?t=' + Date.now());
                const nouvelleVersion = await response.json();
                const versionActuelle = localStorage.getItem('app_version') || '0';
                
                if (nouvelleVersion.version !== versionActuelle) {
                    localStorage.setItem('app_version', nouvelleVersion.version);
                    
                    const div = document.createElement('div');
                    div.innerHTML = `
                        <div style="position:fixed;bottom:80px;left:10px;right:10px;
                                    background:#3B82F6;color:white;padding:15px;
                                    border-radius:20px;z-index:9999;text-align:center;
                                    box-shadow:0 4px 12px rgba(0,0,0,0.3);">
                            <i class="fas fa-sync-alt"></i> Nouvelle version disponible!
                            <button onclick="location.reload(true)" style="margin-left:10px;
                                    background:white;border:none;padding:5px 15px;
                                    border-radius:20px;cursor:pointer;">
                                Actualiser
                            </button>
                        </div>
                    `;
                    document.body.appendChild(div);
                }
            } catch(e) {}
        }
        
        verifierMiseAJour();
        setInterval(verifierMiseAJour, 10 * 60 * 1000);

        const firebaseConfig = {
            apiKey: "AIzaSyAXxYGXAcQhuCssE7c40mxoy5bHx-FACOA",
            authDomain: "typhxchain.firebaseapp.com",
            databaseURL: "https://typhxchain-default-rtdb.firebaseio.com",
            projectId: "typhxchain",
            storageBucket: "typhxchain.firebasestorage.app",
            messagingSenderId: "1036771874416",
            appId: "1:1036771874416:web:aeca9ac347f6bbcc9886b5",
            measurementId: "G-DHMY4MSP9Y"
        };
        
        firebase.initializeApp(firebaseConfig);
        const database = firebase.database();
        const auth = firebase.auth();
        const functionsClient = firebase.app().functions('us-central1');
        const authPersistence = firebase.auth.Auth.Persistence;
        let pendingReferralUid = '';

        // ==================== ACTIVATION APP CHECK (reCAPTCHA v3) ====================
        if (typeof firebase !== 'undefined' && firebase.appCheck) {
            try {
                const appCheck = firebase.appCheck();
                appCheck.activate(
                    "6LfOLcQsAAAAAFDWFvD9RtKw-6hdpYXl1zXKcMG6",
                    true
                );
                console.log('✅ App Check activé avec reCAPTCHA v3');
            } catch(e) {
                console.warn('App Check déjà activé ou erreur:', e);
            }
        }
        // ============================================================================

        function nettoyerSessionsLegacy() {
            localStorage.removeItem('typhSession');
            sessionStorage.removeItem('typhSession');
        }

        function getPersistenceSouhaitee() {
            return document.getElementById('check-rester-connecte')?.checked ? authPersistence.LOCAL : authPersistence.SESSION;
        }

        async function appliquerPersistanceAuth() {
            try {
                await auth.setPersistence(getPersistenceSouhaitee());
            } catch (error) {
                console.warn('Persistance auth non appliquée:', error);
            }
        }

        async function callCloudFunction(name, payload = {}) {
            const callable = functionsClient.httpsCallable(name);
            const result = await callable(payload);
            return result.data;
        }

        function nettoyerCodeParrain(valeur) {
            return String(valeur || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
        }

        async function resoudreUidParrain(codeParrain) {
            const codeNettoye = nettoyerCodeParrain(codeParrain);
            if (!codeNettoye) return '';
            if (/^[A-Za-z0-9_-]{20,}$/.test(codeNettoye)) {
                const directSnapshot = await database.ref(`donnees/utilisateurs/${codeNettoye}`).once('value');
                if (directSnapshot.exists()) return codeNettoye;
            }
            const referralSnapshot = await database.ref('donnees/utilisateurs').orderByChild('id').equalTo(codeNettoye).limitToFirst(1).once('value');
            const referralData = referralSnapshot.val();
            return referralData ? Object.keys(referralData)[0] : '';
        }

        async function creerCleIndexAdresse(cryptoNom, reseauNom, adresseValeur) {
            const base = `${String(cryptoNom || '').trim().toUpperCase()}|${String(reseauNom || '').trim().toUpperCase()}|${String(adresseValeur || '').trim().toLowerCase()}`;
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base));
            return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
        }

        async function reserverIndexAdresse(cryptoNom, reseauNom, adresseValeur, ownerUid) {
            const indexKey = await creerCleIndexAdresse(cryptoNom, reseauNom, adresseValeur);
            const indexRef = database.ref(`donnees/indexes/adresses/${indexKey}`);
            return new Promise((resolve, reject) => {
                indexRef.transaction((currentValue) => {
                    if (currentValue === null || currentValue.uid === ownerUid) {
                        return {
                            uid: ownerUid,
                            crypto: String(cryptoNom || '').trim(),
                            reseau: String(reseauNom || '').trim(),
                            updatedAt: new Date().toISOString()
                        };
                    }
                    return;
                }, (error, committed, snapshot) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve({
                        committed,
                        indexKey,
                        ownerUid: snapshot?.val()?.uid || null
                    });
                }, false);
            });
        }

        async function libererIndexAdresse(indexKey, ownerUid) {
            if (!indexKey || !ownerUid) return;
            await database.ref(`donnees/indexes/adresses/${indexKey}`).transaction((currentValue) => {
                if (currentValue?.uid === ownerUid) {
                    return null;
                }
                return currentValue;
            });
        }

        // ==================== CACHE MANAGER OPTIMISÉ ====================
        const cacheManager = {
            cache: {},
            dureeDefaut: 300000,
            get(key, dureeMs = null) {
                const item = this.cache[key];
                if (!item) return null;
                const duree = dureeMs || this.dureeDefaut;
                if (Date.now() - item.timestamp > duree) {
                    delete this.cache[key];
                    return null;
                }
                return item.data;
            },
            set(key, data) {
                this.cache[key] = { data, timestamp: Date.now() };
                if (Object.keys(this.cache).length > 50) {
                    const now = Date.now();
                    for (const k in this.cache) {
                        if (now - this.cache[k].timestamp > 3600000) delete this.cache[k];
                    }
                }
            },
            clear(key) { if (key) delete this.cache[key]; else this.cache = {}; }
        };

        // ==================== SAUVEGARDE TRIPLE ====================
        function sauvegarderIndexedDB(transaction) {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open('TyphTransactionsDB', 1);
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if(!db.objectStoreNames.contains('transactions')) {
                        const store = db.createObjectStore('transactions', { keyPath: 'id' });
                        store.createIndex('statut', 'statut', { unique: false });
                        store.createIndex('date', 'date', { unique: false });
                        store.createIndex('userID', 'userID', { unique: false });
                    }
                };
                request.onsuccess = (e) => {
                    const db = e.target.result;
                    const tx = db.transaction(['transactions'], 'readwrite');
                    const store = tx.objectStore('transactions');
                    store.put(transaction);
                    tx.oncomplete = () => resolve();
                    tx.onerror = (err) => reject(err);
                };
                request.onerror = (err) => reject(err);
            });
        }
        
        function chargerDepuisIndexedDB() {
            return new Promise((resolve) => {
                const request = indexedDB.open('TyphTransactionsDB', 1);
                request.onsuccess = (e) => {
                    const db = e.target.result;
                    if(!db.objectStoreNames.contains('transactions')) {
                        resolve([]);
                        return;
                    }
                    const tx = db.transaction(['transactions'], 'readonly');
                    const store = tx.objectStore('transactions');
                    const getAll = store.getAll();
                    getAll.onsuccess = () => resolve(getAll.result || []);
                    getAll.onerror = () => resolve([]);
                };
                request.onerror = () => resolve([]);
            });
        }

        let donnees = {
            portefeuilles: [], operateurs: [], cryptos: ["USDT","BTC","ETH","BNB","LTC","SOL","TRX","DOGE","MATIC","SUI","XRP","TON","USDC"],
            taux: {}, reseaux: [], frais: { achat: 1.5, vente: 2.0 }, pause: { achat: false, vente: false }, demandes: {}, news: [],
            tauxMode: 'auto', usdMGA: 4700,
            limites: { minAchat: 2000, minAchatTRX: 5000, maxAchat: 100000, minVente: 2000, maxVente: 100000 },
            messagesSpeciaux: { trx: "Frais réseau TRC20 : 3% ou -1 TRX si activation" },
            roue: [], roueActive: true
        };
        
        let utilisateurCourant = null;
        let sessionValide = false;
        let modeAuth = 'connexion';
        let transactionEnAttente = null;
        let pinSetupValue = '', pinSetupConfirmValue = '', pinVerifValue = '';
        let timerInterval = null, tempsRestant = 900;
        let montantRecuAchat = 0, montantRecuVente = 0, cryptoAchat = '', cryptoVente = '';
        let binanceInterval = null, tauxUSD_MGA = 4700;
        let adresseLieeSelectionnee = null;
        let adressesUtilisateur = {};
        let toursGratuits = 0;
        let filleulsCount = 0;
        let urlParrainage = '';
        let monUid = null;
        
        const pairesBinance = { 'USDT':'USDTUSDT','BTC':'BTCUSDT','ETH':'ETHUSDT','BNB':'BNBUSDT','LTC':'LTCUSDT','SOL':'SOLUSDT','TRX':'TRXUSDT','DOGE':'DOGEUSDT','MATIC':'POLUSDT','SUI':'SUIUSDT','XRP':'XRPUSDT','TON':'TONUSDT','POL':'POLUSDT','USDC':'USDCUSDT' };
        
        let lotsRoue = [];
        let lotGagneInfo = null;

        const lotsParDefaut = [
            { id: 'L1', nom: '10 $ Gratuit', type: 'crypto', probabilite: 0 },
            { id: 'L2', nom: 'Frais de gaz - 0.00004 BNB', type: 'crypto', probabilite: 10 },
            { id: 'L3', nom: 'Crédit 500 Ar', type: 'fiat', probabilite: 1 },
            { id: 'L4', nom: '0.2 TON', type: 'crypto', probabilite: 2 },
            { id: 'L5', nom: 'Merci de votre fidélité', type: 'rien', probabilite: 87 }
        ];

        function getDemandesTableau() {
            if(!donnees.demandes) return [];
            if(Array.isArray(donnees.demandes)) return donnees.demandes;
            return Object.values(donnees.demandes);
        }
        
        function sauvegarderDemandes(demandesArray) {
            const demandesObj = {};
            demandesArray.forEach(d => { if(d && d.id) demandesObj[d.id] = d; });
            donnees.demandes = demandesObj;
            database.ref('donnees/demandes').set(demandesObj);
            demandesArray.forEach(t => sauvegarderIndexedDB(t));
            sauvegarderLocalTransactions(demandesArray);
        }
        
        function sauvegarderLocalTransactions(demandesArray) {
            try {
                sessionStorage.setItem('transactions_backup', JSON.stringify({
                    data: demandesArray,
                    timestamp: Date.now()
                }));
            } catch(e) { console.warn("Erreur sauvegarde locale", e); }
        }

        // ==================== ÉCOUTE EN TEMPS RÉEL DES TRANSACTIONS CONFIRMÉES ====================
        let ecouteTransactionsActive = false;
        
        function demarrerEcouteTransactionsUtilisateur() {
            if (!monUid || ecouteTransactionsActive) return;
            ecouteTransactionsActive = true;
            
            database.ref('donnees/demandes').orderByChild('userID').equalTo(monUid).on('value', (snapshot) => {
                const toutesDemandes = snapshot.val();
                const mesTransactions = Object.values(toutesDemandes || {});
                
                if (mesTransactions.length > 0) {
                    const demandesObj = {};
                    mesTransactions.forEach(t => { if (t && t.id) demandesObj[t.id] = t; });
                    
                    const existingDemandes = getDemandesTableau();
                    const autresDemandes = existingDemandes.filter(d => d.userID !== monUid);
                    const toutesDemandesMisesAJour = [...autresDemandes, ...mesTransactions];
                    
                    const nouvellesDemandesObj = {};
                    toutesDemandesMisesAJour.forEach(d => { if (d && d.id) nouvellesDemandesObj[d.id] = d; });
                    donnees.demandes = nouvellesDemandesObj;
                    
                    sauvegarderLocalTransactions(toutesDemandesMisesAJour);
                    mettreAJourMesDemandes();
                    verifierAccesBonus();
                    
                    const transactionModifiee = mesTransactions.find(t => {
                        const ancienne = existingDemandes.find(ot => ot.id === t.id);
                        return ancienne && ancienne.statut !== t.statut;
                    });
                    
                    if (transactionModifiee && transactionModifiee.statut === 'confirme') {
                        afficherNotificationToast(
                            '✅ Transaction confirmée !',
                            `Votre ${transactionModifiee.type === 'ACHAT' ? 'achat' : 'vente'} a été validé par l'administrateur.`
                        );
                    } else if (transactionModifiee && transactionModifiee.statut === 'rejete') {
                        afficherNotificationToast(
                            '❌ Transaction rejetée',
                            `Votre demande a été rejetée. Contactez le support.`,
                            'error'
                        );
                    }
                }
            });
        }
        
        function afficherNotificationToast(titre, message, type = 'success') {
            const toast = document.createElement('div');
            toast.className = `toast-notification ${type === 'error' ? 'error' : ''}`;
            toast.innerHTML = `
                <i class="fas ${type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'}" style="font-size: 1.5rem;"></i>
                <div style="flex:1">
                    <strong>${titre}</strong><br>
                    <small>${message}</small>
                </div>
                <button onclick="this.parentElement.remove()" style="background:none;border:none;color:white;font-size:1.2rem;cursor:pointer;">×</button>
            `;
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 5000);
        }

        function obtenirDonneesParDefaut() {
            return {
                portefeuilles: [], operateurs: [], cryptos: ["USDT","BTC","ETH","BNB","LTC","SOL","TRX","DOGE","MATIC","SUI","XRP","TON","USDC"],
                reseaux: [], frais: { achat: 1.5, vente: 2.0 }, pause: { achat: false, vente: false }, taux: {}, demandes: {}, news: [],
                tauxMode: 'auto', usdMGA: 4700, limites: { minAchat: 2000, minAchatTRX: 5000, maxAchat: 100000, minVente: 2000, maxVente: 100000 },
                messagesSpeciaux: { trx: "Frais réseau TRC20 : 3% ou -1 TRX si activation" }, roue: lotsParDefaut, roueActive: true
            };
        }

        async function chargerDonnees(forceRefresh = false) {
            const cacheKey = 'donnees_cache';
            if (forceRefresh) cacheManager.clear(cacheKey);
            const cached = cacheManager.get(cacheKey, 600000);
            if (cached) {
                donnees = { ...obtenirDonneesParDefaut(), ...cached };
                if(!donnees.roue || donnees.roue.length === 0) donnees.roue = lotsParDefaut;
                if(!donnees.limites) donnees.limites = obtenirDonneesParDefaut().limites;
                if(!donnees.taux) donnees.taux = {};
                tauxUSD_MGA = donnees.usdMGA || 4700;
                mettreAJourAffichage();
                afficherNews();
                afficherTauxSimplifies();
                return;
            }
            
            try {
                const publicPaths = ['portefeuilles', 'operateurs', 'cryptos', 'reseaux', 'frais', 'pause', 'taux', 'news', 'tauxMode', 'usdMGA', 'limites', 'messagesSpeciaux', 'roue', 'roueActive'];
                const entries = await Promise.all(publicPaths.map(async (path) => {
                    const snapshot = await database.ref(`donnees/${path}`).once('value');
                    return [path, snapshot.val()];
                }));
                const data = Object.fromEntries(entries.filter(([, value]) => value !== null && value !== undefined));
                if(data && Object.keys(data).length > 0){
                    donnees = { ...obtenirDonneesParDefaut(), ...data };
                    cacheManager.set(cacheKey, data);
                    
                    let roueFirebase = data.roue;
                    if (roueFirebase) {
                        let tr = Array.isArray(roueFirebase) ? roueFirebase : Object.values(roueFirebase);
                        donnees.roue = tr.filter(item => item !== null);
                    } else {
                        donnees.roue = lotsParDefaut;
                    }
                    if(!donnees.roue || donnees.roue.length === 0) donnees.roue = lotsParDefaut;
                    if(!donnees.limites) donnees.limites = obtenirDonneesParDefaut().limites;
                    if(!donnees.messagesSpeciaux) donnees.messagesSpeciaux = obtenirDonneesParDefaut().messagesSpeciaux;
                    if(!donnees.taux) donnees.taux = {};
                    if(!donnees.news) donnees.news = obtenirDonneesParDefaut().news;
                    if(!donnees.reseaux) donnees.reseaux = obtenirDonneesParDefaut().reseaux;
                    if(!donnees.portefeuilles) donnees.portefeuilles = obtenirDonneesParDefaut().portefeuilles;
                    if(!donnees.operateurs) donnees.operateurs = obtenirDonneesParDefaut().operateurs;
                    if(!donnees.cryptos) donnees.cryptos = obtenirDonneesParDefaut().cryptos;
                    if(!donnees.demandes) donnees.demandes = {};
                    if(donnees.roueActive === undefined) donnees.roueActive = true;
                    donnees.portefeuilles = donnees.portefeuilles.map(p => ({ ...p, liaisonRequise: p.liaisonRequise || false }));
                    tauxUSD_MGA = donnees.usdMGA || 4700;
                } else {
                    donnees = obtenirDonneesParDefaut();
                    donnees.roueActive = true;
                }
                
                mettreAJourAffichage();
                afficherNews();
                afficherTauxSimplifies();
                demarrerSyncBinance();
                
                if(monUid) {
                    database.ref(`donnees/utilisateurs/${monUid}`).once('value').then(snap => {
                        const userData = snap.val();
                        if(userData) {
                            utilisateurCourant = userData;
                            utilisateurCourant.uid = monUid;
                            sessionValide = true;
                            adressesUtilisateur = utilisateurCourant.adressesLiees || {};
                            toursGratuits = utilisateurCourant.toursGratuits || 0;
                            filleulsCount = utilisateurCourant.filleulsCount || 0;
                            mettreAJourAffichage();
                            demarrerEcouteNumeros();
                            demarrerEcouteAdresses();
                            demarrerEcouteTransactionsUtilisateur();
                            verifierAccesBonus();
                            mettreAJourAffichageAffiliation();
                            if(document.getElementById('landing-page').style.display !== 'none') showPlatform();
                        }
                    });
                }
            } catch(e) { console.error(e); donnees = obtenirDonneesParDefaut(); mettreAJourAffichage(); }
        }

        function mettreAJourAffichage(){
            mettreAJourSelecteurs();
            mettreAJourProfil();
            mettreAJourMesDemandes();
            mettreAJourNumerosUtilisateur();
            mettreAJourListeAdresses();
            afficherTauxSimplifies();
            verifierPause();
            mettreAJourListeNumerosVente();
            mettreAJourListeNumerosAchat();
            mettreAJourLimiteAchat();
            mettreAJourChampAdresseVente();
            verifierAccesBonus();
            mettreAJourAffichageAffiliation();
            if(utilisateurCourant){
                const nomTronque = tronquerNom(utilisateurCourant.nom);
                const userBadgeContainer = document.getElementById('user-badge-bottom-container');
                if(userBadgeContainer) {
                    userBadgeContainer.innerHTML = `<div class="user-badge-bottom" onclick="showAuthModal()"><i class="fas fa-user-check"></i> ${echapperHTML(nomTronque)}</div>`;
                }
                document.getElementById('carte-deconnexion').style.display='block';
            }else{
                const userBadgeContainer = document.getElementById('user-badge-bottom-container');
                if(userBadgeContainer) {
                    userBadgeContainer.innerHTML = `<div class="user-badge-bottom" onclick="showAuthModal()"><i class="fas fa-user-circle"></i> Connexion</div>`;
                }
                document.getElementById('carte-deconnexion').style.display='none';
            }
        }

        function mettreAJourMesDemandes(){ 
            const l=document.getElementById('mes-demandes-liste'); 
            if(!l) return; 
            if(!utilisateurCourant){ l.innerHTML='<div class="activity-item">Connectez-vous</div>'; return; } 
            const demandesArray = getDemandesTableau();
            const m=demandesArray.filter(d=>d.userID===monUid).sort((a,b)=>new Date(b.date)-new Date(a.date)); 
            if(m.length===0){ l.innerHTML='<div class="activity-item">Aucune demande</div>'; return; } 
            l.innerHTML=m.map(d=>{
                let statutAffiche = d.statut;
                let statutClasse = d.statut;
                let iconeStatut = '';
                if (d.statut === 'confirme') {
                    iconeStatut = '<i class="fas fa-check-circle" style="color:var(--success); margin-right:5px;"></i>';
                } else if (d.statut === 'rejete') {
                    iconeStatut = '<i class="fas fa-times-circle" style="color:var(--danger); margin-right:5px;"></i>';
                } else {
                    iconeStatut = '<i class="fas fa-clock" style="color:var(--warning); margin-right:5px;"></i>';
                }
                return `<li class="activity-item" onclick="ouvrirRecu('${echapperHTML(d.id)}')">
                    <div class="activity-left">
                        <div class="activity-icon ${echapperHTML(d.type)}">
                            <i class="fas ${d.type==='ACHAT'?'fa-arrow-down':(d.type==='VENTE'?'fa-arrow-up':'fa-gift')}"></i>
                        </div>
                        <div class="activity-info">
                            <h4>${echapperHTML(d.type)} ${d.crypto ? echapperHTML(d.crypto) : ''}</h4>
                            <div class="activity-date">${echapperHTML(new Date(d.date).toLocaleString())}</div>
                        </div>
                    </div>
                    <div>
                        <div class="activity-amount">${d.type==='ACHAT'?d.montant.toLocaleString()+' Ar':(d.type==='VENTE'?d.montant+' '+d.crypto:'Gain')}</div>
                        <div class="activity-status status-${echapperHTML(statutClasse)}">${iconeStatut} ${echapperHTML(statutAffiche)}</div>
                    </div>
                </li>`;
            }).join(''); 
            verifierAccesBonus();
        }

        function rafraichirMesDemandes() {
            if(monUid) {
                database.ref('donnees/demandes').orderByChild('userID').equalTo(monUid).once('value').then((snapshot) => {
                    const demandes = snapshot.val();
                    if(demandes) { donnees.demandes = demandes; mettreAJourMesDemandes(); verifierAccesBonus(); alert('✅ Demandes actualisées'); }
                    else { donnees.demandes = {}; mettreAJourMesDemandes(); alert('Aucune demande trouvée'); }
                }).catch(err => { console.error(err); alert('Erreur lors du rafraîchissement'); });
            } else { alert('Veuillez vous connecter'); }
        }

        function verifierAccesBonus() {
            const btnRoue = document.getElementById('btn-roue-action');
            const msgRestriction = document.getElementById('bonus-restriction');
            const msgNormal = document.getElementById('bonus-message');
            
            if(!btnRoue) return;
            if(!utilisateurCourant) {
                btnRoue.disabled = true;
                btnRoue.classList.add('btn-wheel-disabled');
                if(msgRestriction) msgRestriction.style.display = 'block';
                if(msgRestriction) msgRestriction.innerHTML = '🔒 Connectez-vous pour jouer';
                if(msgNormal) msgNormal.textContent = '💰 Roue de la Fortune';
                return;
            }
            
            const aujourdhui = new Date().toLocaleDateString('fr-FR');
            const demandesArray = getDemandesTableau();
            
            const aTransactionAujourdhui = demandesArray.some(d => 
                d.userID === monUid && 
                d.statut === 'confirme' && 
                (d.type === 'ACHAT' || d.type === 'VENTE') &&
                new Date(d.date).toLocaleDateString('fr-FR') === aujourdhui
            );
            
            const aJoueAujourdhui = demandesArray.some(d => 
                d.userID === monUid && 
                d.type === 'BONUS' && 
                new Date(d.date).toLocaleDateString('fr-FR') === aujourdhui
            );

            const aTourGratuit = toursGratuits > 0;

            if((aTransactionAujourdhui || aTourGratuit) && !aJoueAujourdhui) {
                btnRoue.disabled = false;
                btnRoue.classList.remove('btn-wheel-disabled');
                btnRoue.classList.add('btn-wheel-active');
                if(msgRestriction) msgRestriction.style.display = 'none';
                if(aTourGratuit && !aTransactionAujourdhui) {
                    if(msgNormal) msgNormal.innerHTML = '🎉 Vous avez un tour gratuit ! Profitez-en maintenant !';
                } else {
                    if(msgNormal) msgNormal.textContent = '🎉 Félicitations ! Vous pouvez jouer maintenant !';
                }
            } else if(aJoueAujourdhui && !aTourGratuit) {
                btnRoue.disabled = true;
                btnRoue.classList.add('btn-wheel-disabled');
                btnRoue.classList.remove('btn-wheel-active');
                if(msgRestriction) msgRestriction.style.display = 'block';
                if(msgRestriction) msgRestriction.innerHTML = '⏰ Vous avez déjà joué aujourd\'hui. Revenez demain !';
                if(msgNormal) msgNormal.textContent = '💰 Roue de la Fortune';
            } else if(aTourGratuit && aJoueAujourdhui) {
                btnRoue.disabled = false;
                btnRoue.classList.remove('btn-wheel-disabled');
                btnRoue.classList.add('btn-wheel-active');
                if(msgRestriction) msgRestriction.style.display = 'none';
                if(msgNormal) msgNormal.innerHTML = '🎉 Vous avez un tour gratuit ! Profitez-en maintenant !';
            } else {
                btnRoue.disabled = true;
                btnRoue.classList.add('btn-wheel-disabled');
                btnRoue.classList.remove('btn-wheel-active');
                if(msgRestriction) msgRestriction.style.display = 'block';
                if(msgRestriction) msgRestriction.innerHTML = '🔒 Une transaction confirmée aujourd\'hui ou un tour gratuit est requis pour jouer';
                if(msgNormal) msgNormal.textContent = '💰 Roue de la Fortune';
            }
        }

        // ==================== FONCTIONS PRINCIPALES (inchangées mais conservées) ====================
        function tronquerNom(nom) { if(!nom) return 'Utilisateur'; const mots = nom.trim().split(/\s+/); if(mots.length <= 4) return nom; return mots.slice(0, 4).join(' '); }
        
        async function syncBinanceManuel() { cacheManager.clear('donnees_cache'); await chargerDonnees(true); alert('✅ Données de marché actualisées depuis le serveur.'); }
        
        async function getTauxMGA() { 
            try{ const r=await fetch('https://api.exchangerate-api.com/v4/latest/USD'); const d=await r.json(); if(d.rates&&d.rates.MGA){ tauxUSD_MGA=d.rates.MGA; return tauxUSD_MGA; } }catch(e){} 
            return donnees.usdMGA||4700; 
        }
        
        async function syncBinance() {
            try {
                const [ratesSnapshot, usdSnapshot] = await Promise.all([
                    database.ref('donnees/taux').once('value'),
                    database.ref('donnees/usdMGA').once('value')
                ]);
                if (ratesSnapshot.exists()) {
                    donnees.taux = ratesSnapshot.val() || {};
                    localStorage.setItem('tauxCache', JSON.stringify({ data: donnees.taux, timestamp: Date.now() }));
                }
                if (usdSnapshot.exists()) {
                    donnees.usdMGA = usdSnapshot.val();
                    tauxUSD_MGA = donnees.usdMGA;
                }
                afficherTauxSimplifies();
                localStorage.setItem('derniereSyncTaux', Date.now().toString());
                afficherAgeTaux();
            } catch (e) {
                console.error(e);
            }
        }
        
        function afficherAgeTaux() {
            const derniereMaj = localStorage.getItem('derniereSyncTaux');
            const element = document.getElementById('taux-last-update');
            if(derniereMaj && element) {
                const age = Math.floor((Date.now() - parseInt(derniereMaj)) / 60000);
                const ageTexte = age < 1 ? 'à l\'instant' : `il y a ${age} minute${age > 1 ? 's' : ''}`;
                element.innerHTML = `📊 Taux mis à jour ${ageTexte} (actualisation toutes les 30 min)`;
            } else if(element) {
                element.innerHTML = `Mise à jour: ${new Date().toLocaleTimeString()}`;
            }
        }
        
        function afficherTauxSimplifies(){ 
            const div=document.getElementById('taux-direct'); 
            if(!div) return; 
            const cs=donnees.cryptos||[]; 
            if(cs.length===0){ div.innerHTML='<div class="rate-card">Aucune crypto</div>'; return; } 
            div.innerHTML=cs.map(c=>{ 
                const t=donnees.taux[c]||{prixUSD:c==='USDT'?1:0,prixMGA:c==='USDT'?donnees.usdMGA:0,variation:"0",couleur:"positive",source:'manual'}; 
                const vc=t.couleur==='positive'?'positive':'negative'; 
                const vi=t.couleur==='positive'?'arrow-up':'arrow-down'; 
                let sym=c; 
                const sp={'MATIC':'POL','POL':'POL','TON':'TON','USDC':'USDC','USDT':'USDT','BTC':'BTC','ETH':'ETH','BNB':'BNB','SOL':'SOL','XRP':'XRP'}; 
                if(sp[c]) sym=sp[c]; 
                return `<div class="rate-card"><div class="rate-pair"><span><i class="fas fa-coins"></i> ${sym}/Ar</span></div><div class="rate-value-main">${t.prixMGA.toLocaleString()} Ar</div><div class="rate-footer"><span class="rate-change ${vc}"><i class="fas fa-${vi}"></i> ${t.variation}%</span></div></div>`; 
            }).join(''); 
        }

        function afficherNews(){ 
            const c=document.getElementById('news-container'); 
            if(!c) return; 
            if(!donnees.news||donnees.news.length===0){ c.innerHTML='<div class="no-news"><i class="fas fa-newspaper"></i><p>Aucune actualité</p></div>'; return; } 
            const nt=[...donnees.news].filter(n=>n.statut!==false).sort((a,b)=>new Date(b.date)-new Date(a.date)); 
            c.innerHTML=nt.map(n=>{ 
                const d=new Date(n.date); 
                const df=d.toLocaleDateString('fr-FR')+' à '+d.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}); 
                return `<div class="news-item" onclick="voirDetailNews('${echapperHTML(n.id)}')"><div class="news-header"><div class="news-title"><i class="fas ${n.important?'fa-exclamation-circle':'fa-newspaper'}"></i>${echapperHTML(n.titre)}</div><div class="news-date">${echapperHTML(df)}</div></div><div class="news-content">${echapperHTML(n.contenu.length>100?n.contenu.substring(0,100)+'...':n.contenu)}</div><div class="news-footer"><span class="news-author"><i class="fas fa-user-shield"></i> ${echapperHTML(n.auteur||'Admin')}</span>${n.important?'<span class="news-important">IMPORTANT</span>':''}</div></div>`; 
            }).join(''); 
        }
        
        function voirDetailNews(id){ 
            const n=donnees.news.find(n=>n.id===id); 
            if(!n) return; 
            document.getElementById('modal-news-title').innerHTML=`<i class="fas fa-newspaper"></i> ${echapperHTML(n.titre)}`; 
            document.getElementById('modal-news-content').innerHTML=echapperHTML(n.contenu).replace(/\n/g,'<br>'); 
            document.getElementById('modal-news-date').innerHTML=`<i class="far fa-calendar"></i> ${echapperHTML(new Date(n.date).toLocaleString('fr-FR'))}`; 
            document.getElementById('modal-news-author').innerHTML=`<i class="fas fa-user-shield"></i> ${echapperHTML(n.auteur||'Admin')}`; 
            document.getElementById('modal-news-detail').classList.add('active'); 
        }
        
        function fermerModalNews(){ document.getElementById('modal-news-detail').classList.remove('active'); }

        function mettreAJourProfil(){ 
            const p=document.getElementById('profil-infos'); 
            if(!p) return; 
            if(utilisateurCourant) p.innerHTML=`<div class="profile-row"><span class="profile-label">ID</span><span class="profile-value" style="color:var(--accent);font-weight:700;">${echapperHTML(utilisateurCourant.id||'Non attribué')}</span></div><div class="profile-row"><span class="profile-label">Nom</span><span class="profile-value">${echapperHTML(utilisateurCourant.nom)}</span></div><div class="profile-row"><span class="profile-label">Email</span><span class="profile-value">${echapperHTML(utilisateurCourant.email||'Non renseigné')}</span></div><div class="profile-row"><span class="profile-label">Membre depuis</span><span class="profile-value">${echapperHTML(new Date(utilisateurCourant.dateInscription).toLocaleDateString())}</span></div><div class="profile-row"><span class="profile-label">Numéros</span><span class="profile-value">${Object.keys(utilisateurCourant.numeros||{}).length} enregistré(s)</span></div><div class="profile-row"><span class="profile-label">Adresses liées</span><span class="profile-value">${Object.keys(adressesUtilisateur).length} enregistrée(s)</span></div><div class="profile-row"><span class="profile-label">Code PIN</span><span class="profile-value">${utilisateurCourant.codePIN?.actif ? '✅ Configuré' : '❌ Non configuré'}</span></div><div class="profile-row"><span class="profile-label">Tours gratuits</span><span class="profile-value">🎟️ ${toursGratuits} tour(s)</span></div><div class="profile-row"><span class="profile-label">Filleuls</span><span class="profile-value">👥 ${filleulsCount} personne(s)</span></div>`; 
            else p.innerHTML='<div class="profile-row">Connectez-vous</div>'; 
        }

        function mettreAJourAffichageAffiliation() {
            const affiliateCard = document.getElementById('affiliate-card');
            if(!utilisateurCourant || !monUid) {
                if(affiliateCard) affiliateCard.style.display = 'none';
                return;
            }
            if(affiliateCard) affiliateCard.style.display = 'block';
            const refCode = utilisateurCourant.id || monUid.substring(0,8);
            urlParrainage = `https://typh-xchain.site/?ref=${refCode}`;
            const linkSpan = document.getElementById('affiliate-link');
            if(linkSpan) linkSpan.textContent = urlParrainage;
            const countSpan = document.getElementById('affiliate-count');
            if(countSpan) countSpan.textContent = filleulsCount;
            const spinsSpan = document.getElementById('free-spins-count');
            if(spinsSpan) spinsSpan.textContent = toursGratuits;
        }

        function copierLienAffiliation() {
            const lien = document.getElementById('affiliate-link')?.textContent;
            if(lien) {
                navigator.clipboard.writeText(lien).then(() => alert('✅ Lien d\'affiliation copié !')).catch(() => alert('❌ Impossible de copier'));
            }
        }

        async function ajouterTourGratuit(parrainId) {
            console.warn('Le parrainage est désormais géré côté backend.', parrainId);
        }

        async function verifierParrainageEtAjouterTour(uid) {
            console.warn('La vérification de parrainage est désormais gérée côté backend.', uid);
        }

        let ecouteNumerosActive = false;
        let ecouteAdressesActive = false;
        
        function demarrerEcouteNumeros() {
            if(!monUid || ecouteNumerosActive) return;
            ecouteNumerosActive = true;
            database.ref(`donnees/utilisateurs/${monUid}/numeros`).on('value', (snapshot) => {
                const numeros = snapshot.val() || {};
                if(utilisateurCourant) {
                    utilisateurCourant.numeros = numeros;
                    mettreAJourNumerosUtilisateur();
                    mettreAJourListeNumerosVente();
                    mettreAJourListeNumerosAchat();
                }
            });
        }
        
        function demarrerEcouteAdresses() {
            if(!monUid || ecouteAdressesActive) return;
            ecouteAdressesActive = true;
            database.ref(`donnees/utilisateurs/${monUid}/adressesLiees`).on('value', (snapshot) => {
                adressesUtilisateur = snapshot.val() || {};
                if(utilisateurCourant) {
                    utilisateurCourant.adressesLiees = adressesUtilisateur;
                    mettreAJourListeAdresses();
                    mettreAJourChampAdresseVente();
                }
            });
        }

        // ==================== FONCTIONS AJOUT NUMÉRO AVEC DOUBLE CONFIRMATION ====================
        function ajouterNumero() {
            if(!utilisateurCourant || !monUid){ showAuthModal(); return; }
            
            const nom = document.getElementById('nouveau-nom').value.trim();
            const numero = document.getElementById('nouveau-numero').value.trim();
            
            if(!nom || !numero){ alert('Veuillez remplir tous les champs'); return; }
            
            const numerosActuels = utilisateurCourant.numeros || {};
            if(Object.keys(numerosActuels).length >= 3){ alert('Limite de 3 numéros atteinte'); return; }
            
            const modalDiv = document.createElement('div');
            modalDiv.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.95);z-index:10000;display:flex;align-items:center;justify-content:center;';
            modalDiv.innerHTML = `
                <div style="background:var(--bg-card);border-radius:40px;padding:30px;max-width:90%;width:350px;text-align:center;">
                    <i class="fas fa-shield-alt" style="font-size:3rem;color:var(--accent);margin-bottom:15px;"></i>
                    <h3 style="color:white;margin-bottom:20px;">🔐 Confirmation numéro</h3>
                    <p style="color:var(--text-secondary);margin-bottom:10px;">
                        Vous avez saisi : <strong style="color:var(--accent);font-size:1.2rem;">${numero}</strong>
                    </p>
                    <p style="color:var(--warning);margin-bottom:15px;font-size:0.85rem;">
                        <i class="fas fa-exclamation-triangle"></i> Pour confirmer, réécrivez le numéro ci-dessous :
                    </p>
                    <input type="tel" id="confirm-numero" class="modal-input" 
                           placeholder="Réécrivez votre numéro" style="margin-bottom:20px;text-align:center;">
                    <div id="confirm-error" style="color:var(--danger);font-size:0.8rem;margin-bottom:15px;display:none;">
                        ❌ Les numéros ne correspondent pas
                    </div>
                    <div style="display:flex;gap:10px;">
                        <button class="btn btn-cancel" onclick="this.closest('div').parentElement.remove()" style="flex:1;">
                            Annuler
                        </button>
                        <button class="btn btn-success" onclick="validerEnvoiNumero('${nom.replace(/'/g, "\\'")}', '${numero.replace(/'/g, "\\'")}')" style="flex:1;">
                            Confirmer l'envoi
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(modalDiv);
        }

        function validerEnvoiNumero(nom, numeroOriginal) {
            const inputConfirm = document.getElementById('confirm-numero');
            const numeroConfirme = inputConfirm?.value.trim();
            const errorDiv = document.getElementById('confirm-error');
            
            if(numeroConfirme !== numeroOriginal) {
                if(errorDiv) {
                    errorDiv.style.display = 'block';
                    errorDiv.textContent = '❌ Les numéros ne correspondent pas. Veuillez réessayer.';
                }
                return;
            }
            
            const modal = inputConfirm.closest('div').parentElement;
            if(modal) modal.remove();
            envoyerNumeroFirebase(nom, numeroOriginal);
        }

        async function envoyerNumeroFirebase(nom, numero) {
            if(!utilisateurCourant || !monUid){ showAuthModal(); return; }
            
            const numerosActuels = utilisateurCourant.numeros || {};
            if(Object.keys(numerosActuels).length >= 3){ alert('Limite de 3 numéros atteinte'); return; }
            
            const idNumero = Date.now().toString();
            const nouveauNumero = { nom: nom, numero: numero, statut: 'en_attente', dateAjout: new Date().toISOString() };
            
            try {
                await database.ref(`donnees/utilisateurs/${monUid}/numeros/${idNumero}`).set(nouveauNumero);
                document.getElementById('nouveau-nom').value = '';
                document.getElementById('nouveau-numero').value = '';
                alert('✅ Numéro envoyé ! En attente d\'approbation par l\'administrateur.');
                
                if(utilisateurCourant) {
                    if(!utilisateurCourant.numeros) utilisateurCourant.numeros = {};
                    utilisateurCourant.numeros[idNumero] = nouveauNumero;
                    mettreAJourNumerosUtilisateur();
                    mettreAJourListeNumerosVente();
                    mettreAJourListeNumerosAchat();
                }
            } catch(error) { console.error(error); alert('Erreur lors de l\'envoi du numéro'); }
        }

        async function supprimerNumero(numeroId) {
            if(!confirm('❌ Supprimer définitivement ce numéro ? Cette action est irréversible.')) return;
            try {
                await database.ref(`donnees/utilisateurs/${monUid}/numeros/${numeroId}`).remove();
                alert('✅ Numéro supprimé avec succès');
                if(utilisateurCourant && utilisateurCourant.numeros) delete utilisateurCourant.numeros[numeroId];
                mettreAJourNumerosUtilisateur();
                mettreAJourListeNumerosVente();
                mettreAJourListeNumerosAchat();
            } catch(error) { console.error(error); alert('Erreur lors de la suppression'); }
        }

        function mettreAJourNumerosUtilisateur() {
            const liste = document.getElementById('liste-numeros-utilisateur');
            if(!liste) return;
            const numeros = utilisateurCourant?.numeros || {};
            if(Object.keys(numeros).length === 0){ liste.innerHTML = '<div class="activity-item">Aucun numéro</div>'; return; }
            liste.innerHTML = Object.entries(numeros).map(([id, num]) => {
                let statusText = '', statusColor = '';
                if(num.statut === 'en_attente') { statusText = '⏳ En attente'; statusColor = 'var(--warning)'; }
                else if(num.statut === 'approuve') { statusText = '✅ Approuvé'; statusColor = 'var(--success)'; }
                else { statusText = '❌ Rejeté'; statusColor = 'var(--danger)'; }
                return `<div class="numero-item"><div class="numero-info"><div class="numero-nom">${echapperHTML(num.nom)}</div><div class="numero-value">${echapperHTML(num.numero)}</div><div class="numero-status" style="color:${statusColor};">${statusText}</div></div><button class="btn btn-delete-adresse" onclick="supprimerNumero('${id}')" style="margin-top:10px;background:var(--danger);width:auto;padding:8px 16px;"><i class="fas fa-trash"></i> Supprimer</button></div>`;
            }).join('');
        }

        function mettreAJourListeNumerosVente() {
            const select = document.getElementById('numero-vente-select');
            if(!select || !utilisateurCourant) return;
            const numeros = utilisateurCourant.numeros || {};
            const numerosApprouves = Object.entries(numeros).filter(([id, num]) => num.statut === 'approuve');
            const ancienneValeur = select.value;
            if(numerosApprouves.length === 0){ select.innerHTML = '<option value="">Aucun numéro approuvé</option>'; select.disabled = true; }
            else { select.disabled = false; select.innerHTML = numerosApprouves.map(([id, num]) => `<option value="${echapperHTML(num.numero)}" data-nom="${echapperHTML(num.nom)}" data-id="${id}">${echapperHTML(num.nom)} - ${echapperHTML(num.numero)}</option>`).join(''); if(ancienneValeur && Array.from(select.options).some(o => o.value === ancienneValeur)) select.value = ancienneValeur; }
        }

        function mettreAJourListeNumerosAchat() {
            const select = document.getElementById('numero-achat-select');
            const groupe = document.getElementById('groupe-numero-achat');
            if(!select || !groupe) return;
            if(!utilisateurCourant){ groupe.style.display = 'none'; return; }
            const numeros = utilisateurCourant.numeros || {};
            const numerosApprouves = Object.entries(numeros).filter(([id, num]) => num.statut === 'approuve');
            if(numerosApprouves.length > 0){
                groupe.style.display = 'block';
                const ancienneValeur = select.value;
                select.innerHTML = numerosApprouves.map(([id, num]) => `<option value="${echapperHTML(num.numero)}" data-nom="${echapperHTML(num.nom)}" data-id="${id}">${echapperHTML(num.nom)} - ${echapperHTML(num.numero)}</option>`).join('');
                if(ancienneValeur && Array.from(select.options).some(o => o.value === ancienneValeur)) select.value = ancienneValeur;
                select.disabled = false;
            } else { groupe.style.display = 'none'; select.innerHTML = '<option value="">Aucun numéro approuvé</option>'; select.disabled = true; }
        }

        function ouvrirModalAjoutAdresse() {
            if(!utilisateurCourant || !monUid){ showAuthModal(); return; }
            const cryptoSelect = document.getElementById('nouvelle-adresse-crypto');
            if(cryptoSelect && donnees.cryptos) cryptoSelect.innerHTML = donnees.cryptos.map(c => `<option value="${echapperHTML(c)}">${echapperHTML(c)}</option>`).join('');
            mettreAJourReseauxParCrypto();
            document.getElementById('nouvelle-adresse-label').value = '';
            document.getElementById('nouvelle-adresse-valeur').value = '';
            document.getElementById('erreur-adresse').classList.remove('show');
            document.getElementById('modal-ajout-adresse').classList.add('active');
        }
        
        function fermerModalAjoutAdresse() { document.getElementById('modal-ajout-adresse').classList.remove('active'); }
        
        function mettreAJourReseauxParCrypto() {
            const crypto = document.getElementById('nouvelle-adresse-crypto')?.value;
            const reseauSelect = document.getElementById('nouvelle-adresse-reseau');
            if(!reseauSelect || !donnees.reseaux || !crypto) return;
            const reseauxFiltres = donnees.reseaux.filter(r => r.crypto === crypto);
            const ancienneValeur = reseauSelect.value;
            reseauSelect.innerHTML = reseauxFiltres.map(r => `<option value="${echapperHTML(r.nom)}">${echapperHTML(r.nom)}</option>`).join('');
            if(ancienneValeur && Array.from(reseauSelect.options).some(o => o.value === ancienneValeur)) reseauSelect.value = ancienneValeur;
        }
        
        async function enregistrerAdresse() {
            const label = document.getElementById('nouvelle-adresse-label').value.trim();
            const adresse = document.getElementById('nouvelle-adresse-valeur').value.trim();
            const crypto = document.getElementById('nouvelle-adresse-crypto')?.value;
            const reseau = document.getElementById('nouvelle-adresse-reseau')?.value;
            
            if(!label || !adresse || !crypto || !reseau) {
                document.getElementById('erreur-adresse').textContent = 'Tous les champs sont requis';
                document.getElementById('erreur-adresse').classList.add('show');
                return;
            }
            
            if(adressesUtilisateur) {
                for(const [id, addr] of Object.entries(adressesUtilisateur)) {
                    if(addr.adresse === adresse && addr.crypto === crypto && addr.reseau === reseau) {
                        document.getElementById('erreur-adresse').textContent = 'Vous avez déjà enregistré cette adresse pour ce couple crypto/réseau';
                        document.getElementById('erreur-adresse').classList.add('show');
                        return;
                    }
                }
            }
            
            const nouvelleAdresse = { label: label, adresse: adresse, crypto: crypto, reseau: reseau, dateAjout: new Date().toISOString() };
            const idAdresse = Date.now().toString();
            let reservation = null;
            try {
                reservation = await reserverIndexAdresse(crypto, reseau, adresse, monUid);
                if (!reservation.committed && reservation.ownerUid !== monUid) {
                    document.getElementById('erreur-adresse').textContent = `Cette adresse est déjà utilisée pour ${crypto}/${reseau}`;
                    document.getElementById('erreur-adresse').classList.add('show');
                    return;
                }
                await database.ref(`donnees/utilisateurs/${monUid}/adressesLiees/${idAdresse}`).set(nouvelleAdresse);
                fermerModalAjoutAdresse();
                alert('✅ Adresse enregistrée avec succès !');
            } catch(error) {
                if (reservation?.indexKey) {
                    await libererIndexAdresse(reservation.indexKey, monUid);
                }
                console.error(error);
                alert('Erreur lors de l\'enregistrement');
            }
        }
        
        async function supprimerAdresse(id) {
            if(!confirm('Supprimer cette adresse ?')) return;
            try {
                const adresse = adressesUtilisateur?.[id];
                await database.ref(`donnees/utilisateurs/${monUid}/adressesLiees/${id}`).remove();
                if (adresse) {
                    const indexKey = await creerCleIndexAdresse(adresse.crypto, adresse.reseau, adresse.adresse);
                    await libererIndexAdresse(indexKey, monUid);
                }
                alert('✅ Adresse supprimée');
            } 
            catch(error) { console.error(error); alert('Erreur lors de la suppression'); }
        }
        
        function mettreAJourListeAdresses() {
            const liste = document.getElementById('liste-adresses-utilisateur');
            if(!liste) return;
            if(!adressesUtilisateur || Object.keys(adressesUtilisateur).length === 0) {
                liste.innerHTML = '<div class="activity-item">Aucune adresse enregistrée</div>';
                return;
            }
            liste.innerHTML = Object.entries(adressesUtilisateur).map(([id, addr]) => `
                <div class="adresse-item">
                    <div class="adresse-label"><i class="fas fa-tag"></i> ${echapperHTML(addr.label)}</div>
                    <div class="adresse-value"><i class="fas fa-link"></i> ${echapperHTML(addr.adresse)}</div>
                    <div class="adresse-details"><span><i class="fas fa-coins"></i> ${echapperHTML(addr.crypto)}</span><span><i class="fas fa-network-wired"></i> ${echapperHTML(addr.reseau)}</span></div>
                    <button class="btn btn-delete-adresse" onclick="supprimerAdresse('${echapperHTML(id)}')"><i class="fas fa-trash"></i> Supprimer</button>
                </div>
            `).join('');
        }
        
        function mettreAJourChampAdresseVente() {
            const portefeuilleSelect = document.getElementById('portefeuille-vente');
            const groupeAdresse = document.getElementById('groupe-adresse-liee');
            const adresseSelect = document.getElementById('adresse-liee-select');
            
            if(!portefeuilleSelect || !groupeAdresse || !adresseSelect) return;
            
            const portefeuilleNom = portefeuilleSelect.value;
            const portefeuille = donnees.portefeuilles?.find(p => p.nom === portefeuilleNom);
            const liaisonRequise = portefeuille?.liaisonRequise || false;
            
            if(liaisonRequise && utilisateurCourant) {
                const crypto = document.getElementById('crypto-vente')?.value;
                const reseau = document.getElementById('reseau-vente')?.value;
                const adressesFiltrees = Object.entries(adressesUtilisateur).filter(([id, addr]) => addr.crypto === crypto && addr.reseau === reseau);
                
                if(adressesFiltrees.length > 0) {
                    groupeAdresse.style.display = 'block';
                    const ancienneValeur = adresseSelect.value;
                    adresseSelect.innerHTML = `<option value="">Sélectionnez une adresse</option>` + adressesFiltrees.map(([id, addr]) => `<option value="${echapperHTML(addr.adresse)}" data-label="${echapperHTML(addr.label)}" data-id="${id}">${echapperHTML(addr.label)} - ${echapperHTML(addr.adresse.substring(0,20))}...</option>`).join('');
                    if(ancienneValeur && Array.from(adresseSelect.options).some(o => o.value === ancienneValeur)) adresseSelect.value = ancienneValeur;
                    adresseSelect.disabled = false;
                    const btnSuivant = document.getElementById('btn-confirmer-vente');
                    if(btnSuivant) btnSuivant.disabled = !adresseSelect.value;
                } else {
                    groupeAdresse.style.display = 'block';
                    adresseSelect.innerHTML = '<option value="">Aucune adresse enregistrée pour ce couple crypto/réseau</option>';
                    adresseSelect.disabled = true;
                    const btnSuivant = document.getElementById('btn-confirmer-vente');
                    if(btnSuivant) btnSuivant.disabled = true;
                }
            } else {
                groupeAdresse.style.display = 'none';
                adresseLieeSelectionnee = null;
                const btnSuivant = document.getElementById('btn-confirmer-vente');
                if(btnSuivant) btnSuivant.disabled = false;
            }
        }
        
        function selectionnerAdresseLiee() {
            const select = document.getElementById('adresse-liee-select');
            const infoDiv = document.getElementById('info-adresse-liee');
            if(select && select.value) {
                const label = select.selectedOptions[0]?.dataset?.label || '';
                adresseLieeSelectionnee = select.value;
                infoDiv.innerHTML = `<i class="fas fa-check-circle" style="color:var(--success);"></i> Adresse sélectionnée: ${echapperHTML(label)}<br><small style="word-break:break-all;">${echapperHTML(select.value)}</small>`;
                const btnSuivant = document.getElementById('btn-confirmer-vente');
                if(btnSuivant) btnSuivant.disabled = false;
            } else {
                adresseLieeSelectionnee = null;
                infoDiv.innerHTML = '';
                const btnSuivant = document.getElementById('btn-confirmer-vente');
                if(btnSuivant) btnSuivant.disabled = true;
            }
        }

        function aNumeroApprouve() {
            const numeros = utilisateurCourant?.numeros || {};
            return Object.values(numeros).some(num => num.statut === 'approuve');
        }

        function preparerConfirmation(type) {
            if(!sessionValide || !utilisateurCourant){ alert('Veuillez vous connecter'); showAuthModal(); return; }
            if(type === 'ACHAT'){
                const selectNumero = document.getElementById('numero-achat-select');
                if(!selectNumero || !selectNumero.value){ alert('Veuillez sélectionner un numéro à débiter'); return; }
                if(!verifierLimitesAchat()){ alert('Montant hors limites'); return; }
                const montant = parseFloat(document.getElementById('montant-achat').value);
                if(isNaN(montant) || montant <= 0){ alert('Montant invalide'); return; }
            } else if(type === 'VENTE'){
                const selectNumero = document.getElementById('numero-vente-select');
                if(!selectNumero || !selectNumero.value){ alert('Veuillez sélectionner un numéro à créditer'); return; }
                if(!verifierLimitesVente()){ alert('Montant hors limites'); return; }
                const montant = parseFloat(document.getElementById('montant-vente').value);
                if(isNaN(montant) || montant <= 0){ alert('Montant invalide'); return; }
                const portefeuilleNom = document.getElementById('portefeuille-vente')?.value;
                const portefeuille = donnees.portefeuilles?.find(p => p.nom === portefeuilleNom);
                if(portefeuille?.liaisonRequise && !adresseLieeSelectionnee) { alert('Veuillez sélectionner votre adresse de réception'); return; }
            }
            
            if(type === 'ACHAT'){
                transactionEnAttente = {
                    type: 'ACHAT',
                    montant: parseFloat(document.getElementById('montant-achat').value),
                    operateur: document.getElementById('operateur-achat').value,
                    crypto: document.getElementById('crypto-achat').value,
                    reseau: document.getElementById('reseau-achat').value,
                    portefeuille: document.getElementById('portefeuille-achat').value,
                    adresse: document.getElementById('adresse-achat').value,
                    numero: document.getElementById('numero-achat-select').value,
                    nomNumero: document.getElementById('numero-achat-select').selectedOptions[0]?.dataset?.nom || '',
                    montantRecu: montantRecuAchat
                };
            } else {
                const portefeuilleNom = document.getElementById('portefeuille-vente')?.value;
                const portefeuille = donnees.portefeuilles?.find(p => p.nom === portefeuilleNom);
                const adresseUtilisee = (portefeuille?.liaisonRequise && adresseLieeSelectionnee) ? adresseLieeSelectionnee : null;
                transactionEnAttente = {
                    type: 'VENTE',
                    montant: parseFloat(document.getElementById('montant-vente').value),
                    crypto: document.getElementById('crypto-vente').value,
                    reseau: document.getElementById('reseau-vente').value,
                    operateur: document.getElementById('operateur-vente').value,
                    portefeuille: portefeuilleNom,
                    numero: document.getElementById('numero-vente-select').value,
                    nomNumero: document.getElementById('numero-vente-select').selectedOptions[0]?.dataset?.nom || '',
                    montantRecu: montantRecuVente,
                    adresseLiee: adresseUtilisee 
                };
            }
            ouvrirModalConfirmation();
        }
        
        function ouvrirModalConfirmation(){
            if(!transactionEnAttente) return;
            const modal = document.getElementById('modal-confirmation');
            const detailsDiv = document.getElementById('details-demande');
            const messageContainer = document.getElementById('message-paiement-container');
            const messageTexte = document.getElementById('message-paiement-texte');
            let detailsHtml = '';
            let messagePaiement = '';
            
            if(transactionEnAttente.type === 'ACHAT'){
                const operateur = donnees.operateurs.find(o => o.nom === transactionEnAttente.operateur);
                messagePaiement = operateur ? operateur.messageConfirmation : 'Effectuez le paiement au numéro indiqué';
                detailsHtml = `<p><strong>Type:</strong> <span>ACHAT de crypto</span></p><p><strong>Montant à payer:</strong> <span>${transactionEnAttente.montant.toLocaleString()} Ar</span></p><p><strong>Crypto reçue:</strong> <span>${transactionEnAttente.montantRecu.toFixed(4)} ${transactionEnAttente.crypto}</span></p><p><strong>Opérateur:</strong> <span>${echapperHTML(transactionEnAttente.operateur)}</span></p><p><strong>Réseau:</strong> <span>${echapperHTML(transactionEnAttente.reseau)}</span></p><p><strong>Portefeuille destination:</strong> <span>${echapperHTML(transactionEnAttente.portefeuille)}</span></p><p><strong>Adresse destination:</strong> <span style="word-break:break-all;">${echapperHTML(transactionEnAttente.adresse || 'Non spécifiée')}</span></p><p><strong>Numéro à débiter:</strong> <span>${echapperHTML(transactionEnAttente.nomNumero)} (${echapperHTML(transactionEnAttente.numero)})</span></p>`;
            } else {
                const portefeuille = donnees.portefeuilles.find(p => p.nom === transactionEnAttente.portefeuille);
                messagePaiement = portefeuille ? portefeuille.messageConfirmation : 'Envoyez les cryptos à l\'adresse indiquée';
                let adresseDestinataire = '';
                if(transactionEnAttente.adresseLiee) {
                    adresseDestinataire = `<p><strong>📍 Mon adresse de réception:</strong> <span style="word-break:break-all;">${echapperHTML(transactionEnAttente.adresseLiee)}</span></p>`;
                } else {
                    adresseDestinataire = `<p><strong>Adresse du portefeuille:</strong> <span style="word-break:break-all;">${portefeuille ? echapperHTML(portefeuille.reponse) : 'Non spécifiée'}</span></p>`;
                }
                detailsHtml = `<p><strong>Type:</strong> <span>VENTE de crypto</span></p><p><strong>Crypto à envoyer:</strong> <span>${transactionEnAttente.montant} ${transactionEnAttente.crypto}</span></p><p><strong>Montant reçu:</strong> <span>${transactionEnAttente.montantRecu.toLocaleString()} Ar</span></p><p><strong>Réseau:</strong> <span>${echapperHTML(transactionEnAttente.reseau)}</span></p><p><strong>Portefeuille source:</strong> <span>${echapperHTML(transactionEnAttente.portefeuille)}</span></p>${adresseDestinataire}<p><strong>Opérateur:</strong> <span>${echapperHTML(transactionEnAttente.operateur)}</span></p><p><strong>Numéro à créditer:</strong> <span>${echapperHTML(transactionEnAttente.nomNumero)} (${echapperHTML(transactionEnAttente.numero)})</span></p>`;
            }
            
            detailsDiv.innerHTML = detailsHtml;
            messageTexte.textContent = messagePaiement;
            messageContainer.style.display = 'block';
            document.getElementById('txid-input').value = '';
            tempsRestant = 900;
            demarrerTimer();
            modal.classList.add('active');
        }
        
        function demarrerTimer(){
            if(timerInterval) clearInterval(timerInterval);
            const timerDisplay = document.getElementById('timer-display');
            timerInterval = setInterval(() => {
                if(tempsRestant <= 0){ clearInterval(timerInterval); timerDisplay.textContent = '00:00'; alert('Délai expiré. Veuillez refaire une demande.'); fermerModalConfirmation(); }
                else { tempsRestant--; const minutes = Math.floor(tempsRestant / 60); const secondes = tempsRestant % 60; timerDisplay.textContent = `${minutes.toString().padStart(2,'0')}:${secondes.toString().padStart(2,'0')}`; }
            }, 1000);
        }
        
        function fermerModalConfirmation(){ if(timerInterval) clearInterval(timerInterval); document.getElementById('modal-confirmation').classList.remove('active'); }
        
        function copierMessagePaiement(){ const message = document.getElementById('message-paiement-texte').textContent; navigator.clipboard.writeText(message).then(() => { alert('Message copié !'); }); }
        
        function validerConfirmation(){
            const txid = document.getElementById('txid-input').value.trim();
            if(!txid){ alert('Veuillez fournir le TXID ou la preuve d\'envoi'); return; }
            if(!utilisateurCourant.codePIN || !utilisateurCourant.codePIN.actif){ alert('Veuillez d\'abord configurer votre code PIN dans le profil'); fermerModalConfirmation(); switchPlatformSection('profil'); return; }
            if(utilisateurCourant.codePIN.bloque){ alert('Code PIN bloqué après trop de tentatives. Contactez l\'administrateur pour le débloquer.'); fermerModalConfirmation(); return; }
            transactionEnAttente.txid = txid;
            fermerModalConfirmation();
            ouvrirModalPIN();
        }
        
        function ouvrirModalPIN(){
            const modal = document.getElementById('modal-pin');
            const setupDiv = document.getElementById('pin-setup');
            const verificationDiv = document.getElementById('pin-verification');
            const resetDiv = document.getElementById('pin-reset');
            resetDiv.style.display = 'none';
            if(utilisateurCourant && utilisateurCourant.codePIN && utilisateurCourant.codePIN.actif){
                setupDiv.style.display = 'none';
                verificationDiv.style.display = 'block';
                pinVerifValue = '';
                mettreAJourAffichagePINVerification();
                document.getElementById('pin-error').classList.remove('show');
                const tentativas = utilisateurCourant.codePIN.tentativeEchouees || 0;
                document.getElementById('pin-tentatives').textContent = `Tentatives restantes: ${3 - tentativas}`;
            } else {
                setupDiv.style.display = 'block';
                verificationDiv.style.display = 'none';
                pinSetupValue = '';
                pinSetupConfirmValue = '';
                mettreAJourAffichagePIN('setup');
                mettreAJourAffichagePIN('setup-confirm');
                document.getElementById('pin-setup-error').classList.remove('show');
            }
            modal.classList.add('active');
        }
        
        function fermerModalPIN(){ document.getElementById('modal-pin').classList.remove('active'); pinSetupValue = ''; pinSetupConfirmValue = ''; pinVerifValue = ''; }
        
        function ajouterChiffrePIN(mode, chiffre){
            if(mode === 'setup'){ if(pinSetupValue.length < 6){ pinSetupValue += chiffre; mettreAJourAffichagePIN('setup'); } }
            else if(mode === 'setup-confirm'){ if(pinSetupConfirmValue.length < 6){ pinSetupConfirmValue += chiffre; mettreAJourAffichagePIN('setup-confirm'); } }
        }
        
        function ajouterChiffrePINVerification(chiffre){ if(pinVerifValue.length < 6){ pinVerifValue += chiffre; mettreAJourAffichagePINVerification(); } }
        function effacerDernierPIN(mode){
            if(mode === 'setup'){ pinSetupValue = pinSetupValue.slice(0, -1); mettreAJourAffichagePIN('setup'); }
            else if(mode === 'setup-confirm'){ pinSetupConfirmValue = pinSetupConfirmValue.slice(0, -1); mettreAJourAffichagePIN('setup-confirm'); }
        }
        function effacerPIN(mode){
            if(mode === 'setup'){ pinSetupValue = ''; mettreAJourAffichagePIN('setup'); }
            else if(mode === 'setup-confirm'){ pinSetupConfirmValue = ''; mettreAJourAffichagePIN('setup-confirm'); }
        }
        function effacerDernierPINVerification(){ pinVerifValue = pinVerifValue.slice(0, -1); mettreAJourAffichagePINVerification(); }
        function effacerPINVerification(){ pinVerifValue = ''; mettreAJourAffichagePINVerification(); }
        
        function mettreAJourAffichagePIN(mode){
            const valeur = mode === 'setup' ? pinSetupValue : pinSetupConfirmValue;
            for(let i = 1; i <= 6; i++){
                const digit = document.getElementById(`${mode}-digit${i}`);
                if(digit){ if(i <= valeur.length){ digit.textContent = '●'; digit.classList.add('filled'); } else { digit.textContent = ''; digit.classList.remove('filled'); } }
            }
        }
        
        function mettreAJourAffichagePINVerification(){
            for(let i = 1; i <= 6; i++){
                const digit = document.getElementById(`verif-digit${i}`);
                if(digit){ if(i <= pinVerifValue.length){ digit.textContent = '●'; digit.classList.add('filled'); } else { digit.textContent = ''; digit.classList.remove('filled'); } }
            }
        }
        
        function selectionnerCasePIN(idx){}
        
        function afficherResetPIN() {
            document.getElementById('pin-verification').style.display = 'none';
            document.getElementById('pin-reset').style.display = 'block';
            document.getElementById('reset-pin-error').classList.remove('show');
            document.getElementById('reset-pin-id').value = '';
        }
        function annulerResetPIN() {
            document.getElementById('pin-reset').style.display = 'none';
            document.getElementById('pin-verification').style.display = 'block';
        }
        async function validerResetPIN() {
            const inputEmail = document.getElementById('reset-pin-id').value.trim().toLowerCase();
            const erreurDiv = document.getElementById('reset-pin-error');
            if(!auth.currentUser || !auth.currentUser.email) { erreurDiv.textContent = 'Session expirée. Reconnectez-vous.'; erreurDiv.classList.add('show'); return; }
            if(!inputEmail) { erreurDiv.textContent = 'Veuillez confirmer votre email'; erreurDiv.classList.add('show'); return; }
            if(inputEmail !== auth.currentUser.email.toLowerCase()) { erreurDiv.textContent = 'Email de confirmation incorrect'; erreurDiv.classList.add('show'); return; }
            const password = window.prompt('Entrez votre mot de passe actuel pour réinitialiser le code PIN.');
            if(!password) { erreurDiv.textContent = 'Réinitialisation annulée'; erreurDiv.classList.add('show'); return; }
            try {
                const credential = firebase.auth.EmailAuthProvider.credential(auth.currentUser.email, password);
                await auth.currentUser.reauthenticateWithCredential(credential);
                const result = await callCloudFunction('resetPin');
                if(utilisateurCourant) utilisateurCourant.codePIN = result.codePIN;
                alert('✅ Code PIN réinitialisé ! Veuillez configurer un nouveau code.');
                document.getElementById('pin-reset').style.display = 'none';
                ouvrirModalPIN();
            } catch(e) { console.error(e); erreurDiv.textContent = 'Mot de passe incorrect ou session trop ancienne'; erreurDiv.classList.add('show'); }
        }
        
        async function sauvegarderPIN(){
            if(pinSetupValue.length !== 6){ document.getElementById('pin-setup-error').textContent = 'Le code PIN doit contenir 6 chiffres'; document.getElementById('pin-setup-error').classList.add('show'); return; }
            if(pinSetupValue !== pinSetupConfirmValue){ document.getElementById('pin-setup-error').textContent = 'Les codes PIN ne correspondent pas'; document.getElementById('pin-setup-error').classList.add('show'); return; }
            try {
                const result = await callCloudFunction('setPin', { pin: pinSetupValue });
                if(utilisateurCourant) { utilisateurCourant.codePIN = result.codePIN; }
                alert('✅ Code PIN enregistré avec succès !');
                fermerModalPIN();
                mettreAJourProfil();
            } catch(error){ console.error(error); alert('Erreur lors de l\'enregistrement du PIN'); }
        }
        
        async function verifierPIN(){
            if(pinVerifValue.length !== 6){ document.getElementById('pin-error').textContent = 'Code PIN invalide (6 chiffres requis)'; document.getElementById('pin-error').classList.add('show'); return; }
            if(!utilisateurCourant || !utilisateurCourant.codePIN || !utilisateurCourant.codePIN.actif){ alert('Code PIN non configuré'); fermerModalPIN(); return; }
            try {
                const result = await callCloudFunction('submitTransaction', {
                    pin: pinVerifValue,
                    transaction: transactionEnAttente
                });
                document.getElementById('pin-error').classList.remove('show');
                if(utilisateurCourant) utilisateurCourant.codePIN = { ...utilisateurCourant.codePIN, ...result.codePIN };
                fermerModalPIN();
                const demandesArray = getDemandesTableau();
                demandesArray.unshift(result.transaction);
                donnees.demandes = Object.fromEntries(demandesArray.filter(Boolean).map((item) => [item.id, item]));
                ouvrirModalSucces(result.transaction);
                transactionEnAttente = null;
                adresseLieeSelectionnee = null;
                setTimeout(() => { switchPlatformSection('demandes'); mettreAJourMesDemandes(); verifierAccesBonus(); }, 2000);
            } catch (error) {
                console.error(error);
                const message = error?.message || 'Code PIN incorrect';
                const match = message.match(/Tentatives restantes: (\d+)/);
                if (match && utilisateurCourant?.codePIN) {
                    utilisateurCourant.codePIN.tentativeEchouees = 3 - Number(match[1]);
                    utilisateurCourant.codePIN.bloque = Number(match[1]) <= 0;
                    document.getElementById('pin-tentatives').textContent = `Tentatives restantes: ${match[1]}`;
                }
                document.getElementById('pin-error').textContent = message;
                document.getElementById('pin-error').classList.add('show');
                pinVerifValue = '';
                mettreAJourAffichagePINVerification();
            }
        }
        
        async function creerDemande(){
            if(!transactionEnAttente || !utilisateurCourant) return;
            const demande = { id: genererIDStable(utilisateurCourant.email, Date.now().toString()), type: transactionEnAttente.type, date: new Date().toISOString(), utilisateur: utilisateurCourant.nom, email: utilisateurCourant.email, userID: monUid, statut: 'en_attente', txid: transactionEnAttente.txid, ...transactionEnAttente };
            const demandesArray = getDemandesTableau();
            demandesArray.unshift(demande);
            sauvegarderDemandes(demandesArray);
            ouvrirModalSucces(demande);
            transactionEnAttente = null;
            adresseLieeSelectionnee = null;
            setTimeout(() => { switchPlatformSection('demandes'); mettreAJourMesDemandes(); verifierAccesBonus(); }, 2000);
        }
        
        function ouvrirModalSucces(demande){
            const modal = document.getElementById('modal-recu');
            const recuContent = document.getElementById('recu-content');
            const montantRecu = demande.type === 'ACHAT' ? `${demande.montantRecu.toFixed(4)} ${demande.crypto}` : `${demande.montantRecu.toLocaleString()} Ar`;
            recuContent.innerHTML = `<div class="receipt-amount-large"><div class="amount">${echapperHTML(montantRecu)}</div><div class="description">${demande.type === 'ACHAT' ? 'Achat effectué' : 'Vente effectuée'}</div><div class="badge-statut en_attente">EN ATTENTE</div></div><div class="receipt-details"><div class="detail-row"><span class="detail-label">ID Transaction</span><span class="detail-value">${echapperHTML(demande.id)}</span></div><div class="detail-row"><span class="detail-label">Type</span><span class="detail-value">${echapperHTML(demande.type)}</span></div><div class="detail-row"><span class="detail-label">Montant</span><span class="detail-value">${demande.type === 'ACHAT' ? demande.montant.toLocaleString() + ' Ar' : demande.montant + ' ' + demande.crypto}</span></div><div class="detail-row"><span class="detail-label">Vous recevez</span><span class="detail-value">${echapperHTML(montantRecu)}</span></div><div class="detail-row"><span class="detail-label">TXID</span><span class="detail-value small">${echapperHTML(demande.txid)}</span></div><div class="detail-row"><span class="detail-label">Statut</span><span class="detail-value">En attente de validation</span></div></div><p style="text-align:center; color:var(--warning); margin-top:15px;"><i class="fas fa-clock"></i> Votre demande est en cours de traitement par l'administrateur</p>`;
            modal.classList.add('active');
        }
        
        function fermerModalRecu(){ document.getElementById('modal-recu').classList.remove('active'); }
        function verifierMesActifs(){ fermerModalRecu(); switchPlatformSection('accueil'); }
        function noter(v){ alert(`Merci pour votre ${v==='positif'||v==='negatif'?`retour ${v}`:`note de ${v} étoile(s)`} !`); window.open('https://www.facebook.com/Typh.Exchange.Ofisialy','_blank'); }
        function gererPIN(){ if(!sessionValide || !utilisateurCourant){ showAuthModal(); return; } ouvrirModalPIN(); }

        function ouvrirRecu(id){ 
            const demandesArray = getDemandesTableau();
            const d=demandesArray.find(d=>d.id===id); 
            if(!d) return; 
            let mp='',desc='',st='',cl=''; 
            if(d.statut==='confirme'){ st='confirmée'; cl='confirme'; }else if(d.statut==='en_attente'){ st='en attente'; cl='en_attente'; }else if(d.statut==='rejete'){ st='rejetée'; cl='rejete'; } 
            if(d.type==='ACHAT'){ mp=(d.montantRecu||0).toFixed(4)+' '+d.crypto; desc=`Achat ${st} de ${parseFloat(d.montant).toLocaleString()} Ar`; }
            else if(d.type==='VENTE'){ mp=(d.montantRecu||0).toLocaleString()+' Ar'; desc=`Vente ${st} de ${d.montant} ${d.crypto}`; } 
            else if(d.type==='BONUS'){ mp=echapperHTML(d.lotGagne || d.montant || 'N/A'); desc=`Bonus de fidélité ${st}`; }
            let b='';
            if(d.type==='ACHAT') b=d.nomNumero?`${d.nomNumero} (${d.numero})`:d.adresse||'Non spécifié';
            else if(d.type==='VENTE') b=d.nomNumero?`${d.nomNumero} (${d.numero})`:d.numero||'Non spécifié';
            else if(d.type==='BONUS') b=d.adresse || d.numero || 'Non spécifié';

            let typeInfoHtml = '';
            if(d.type !== 'BONUS') {
                typeInfoHtml = `<div class="detail-row"><span class="detail-label">Crypto</span><span class="detail-value">${echapperHTML(d.crypto)}</span></div><div class="detail-row"><span class="detail-label">Réseau</span><span class="detail-value">${echapperHTML(d.reseau||'N/A')}</span></div><div class="detail-row"><span class="detail-label">Montant envoyé</span><span class="detail-value">${d.type==='ACHAT'?parseFloat(d.montant).toLocaleString()+' Ar':d.montant+' '+d.crypto}</span></div>`;
            }

            document.getElementById('recu-content').innerHTML=`<div class="receipt-amount-large"><div class="amount">${echapperHTML(mp)}</div><div class="description">${echapperHTML(desc)}</div><div class="badge-statut ${echapperHTML(cl)}">${echapperHTML(d.statut.toUpperCase())}</div></div><div class="receipt-details"><div class="detail-row"><span class="detail-label">ID Transaction</span><span class="detail-value small">${echapperHTML(d.id)}</span></div><div class="detail-row"><span class="detail-label">ID Client</span><span class="detail-value small">${echapperHTML(d.userID||'Non attribué')}</span></div><div class="detail-row"><span class="detail-label">Date</span><span class="detail-value">${echapperHTML(new Date(d.date).toLocaleString('fr-FR'))}</span></div><div class="detail-row"><span class="detail-label">Type</span><span class="detail-value">${echapperHTML(d.type)}</span></div>${typeInfoHtml}<div class="detail-row"><span class="detail-label">${d.type==='BONUS'?'Info Réception':'Bénéficiaire / Débiteur'}</span><span class="detail-value small">${echapperHTML(b)}</span></div><div class="detail-row"><span class="detail-label">TXID/Preuve</span><span class="detail-value small" style="cursor:pointer;" onclick="copierTexte('${echapperHTML(d.txid)}')">${d.txid?echapperHTML(d.txid.substring(0,20))+'...':'Non fourni'} ${d.txid?'<i class="fas fa-copy" style="margin-left:5px;"></i>':''}</span></div></div>`; 
            document.getElementById('modal-recu').classList.add('active'); 
        }
        
        function copierTexte(t){ if(t) navigator.clipboard.writeText(t).then(()=>alert('✅ TXID copié !')); }
        function scrollToTestimonials(){ document.getElementById('testimonials').scrollIntoView({behavior:'smooth'}); }
        function afficherInfosNumeroAchat(){ 
            const select = document.getElementById('numero-achat-select');
            const infoDiv = document.getElementById('info-numero-achat-selectionne');
            if(select && select.value && infoDiv){ const nom = select.selectedOptions[0]?.dataset?.nom || ''; infoDiv.innerHTML = `<i class="fas fa-check-circle" style="color:var(--success);"></i> Numéro sélectionné: ${echapperHTML(nom)} (${echapperHTML(select.value)})`; }
            else if(infoDiv){ infoDiv.innerHTML = ''; }
        }
        
        function afficherInfosNumeroVente(){ 
            const select = document.getElementById('numero-vente-select');
            const infoDiv = document.getElementById('info-numero-selectionne');
            if(select && select.value && infoDiv){ const nom = select.selectedOptions[0]?.dataset?.nom || ''; infoDiv.innerHTML = `<i class="fas fa-check-circle" style="color:var(--success);"></i> Numéro sélectionné: ${echapperHTML(nom)} (${echapperHTML(select.value)})`; }
            else if(infoDiv){ infoDiv.innerHTML = ''; }
        }
        
        function fermerDetailsDemande(){ document.getElementById('modal-details-demande').classList.remove('active'); }

        function verifierAvantAcces(s){ 
            if(!sessionValide||!utilisateurCourant){ showAuthModal(); return; } 
            if(!aNumeroApprouve()&&(s==='achat'||s==='vente'||s==='demandes')){ alert('Vous devez avoir un numéro approuvé. Ajoutez un numéro dans votre profil et attendez la validation.'); switchPlatformSection('profil'); return; } 
            if(s==='achat'&&donnees.pause?.achat){ alert('Service suspendu'); switchPlatformSection('accueil'); return; } 
            if(s==='vente'&&donnees.pause?.vente){ alert('Service suspendu'); switchPlatformSection('accueil'); return; } 
            switchPlatformSection(s); 
            if(s==='vente') afficherReponseVente(); 
            if(s==='demandes') mettreAJourMesDemandes(); 
            if(s==='achat'){ mettreAJourReseaux('achat'); estimerAchat(); afficherFraisReseauAchat(); verifierLimitesAchat(); mettreAJourListeNumerosAchat(); mettreAJourLimiteAchat(); } 
            if(s==='vente'){ mettreAJourReseaux('vente'); estimerVente(); afficherFraisReseauVente(); verifierLimitesVente(); mettreAJourListeNumerosVente(); mettreAJourChampAdresseVente(); } 
        }
        
        function switchPlatformSection(s){ 
            document.querySelectorAll('.platform-section').forEach(sec=>sec.classList.remove('active')); 
            document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active')); 
            document.getElementById(`${s}-section`).classList.add('active'); 
            document.getElementById(`nav-${s}`).classList.add('active'); 
            if(s==='vente'){ afficherReponseVente(); estimerVente(); afficherFraisReseauVente(); verifierLimitesVente(); mettreAJourListeNumerosVente(); mettreAJourChampAdresseVente(); } 
            if(s==='achat'){ estimerAchat(); afficherFraisReseauAchat(); verifierLimitesAchat(); mettreAJourListeNumerosAchat(); mettreAJourLimiteAchat(); } 
            if(s==='demandes'&&utilisateurCourant) mettreAJourMesDemandes(); 
            if(s==='profil') { mettreAJourNumerosUtilisateur(); verifierAccesBonus(); mettreAJourAffichageAffiliation(); }
            if(s==='accueil') afficherNews(); 
        }

        function demarrerSyncBinance() {
            if(binanceInterval) clearInterval(binanceInterval);
            syncBinance();
            binanceInterval = setInterval(syncBinance, 1800000);
            afficherAgeTaux();
            setInterval(afficherAgeTaux, 60000);
        }
        
        // ==================== FONCTIONS UTILITAIRES (suite) ====================
        function mettreAJourSelecteurs(){ 
            const oa=document.getElementById('operateur-achat')?.value,ca=document.getElementById('crypto-achat')?.value,pa=document.getElementById('portefeuille-achat')?.value,ra=document.getElementById('reseau-achat')?.value; 
            const cv=document.getElementById('crypto-vente')?.value,rv=document.getElementById('reseau-vente')?.value,ov=document.getElementById('operateur-vente')?.value,pv=document.getElementById('portefeuille-vente')?.value; 
            ['achat','vente'].forEach(t=>{ 
                const op=document.getElementById(`operateur-${t}`); 
                if(op&&donnees.operateurs) op.innerHTML=donnees.operateurs.map(o=>`<option value="${echapperHTML(o.nom)}">${echapperHTML(o.nom)}</option>`).join(''); 
                const cr=document.getElementById(`crypto-${t}`); 
                if(cr&&donnees.cryptos) cr.innerHTML=donnees.cryptos.map(c=>`<option value="${echapperHTML(c)}">${echapperHTML(c)}</option>`).join(''); 
                const pf=document.getElementById(`portefeuille-${t}`); 
                if(pf&&donnees.portefeuilles) pf.innerHTML=donnees.portefeuilles.map(p=>`<option value="${echapperHTML(p.nom)}">${echapperHTML(p.nom)} ${p.reseau?echapperHTML(p.reseau):''}</option>`).join(''); 
            }); 
            if(oa) document.getElementById('operateur-achat').value=oa; 
            if(ca) document.getElementById('crypto-achat').value=ca; 
            if(pa) document.getElementById('portefeuille-achat').value=pa; 
            if(ra) document.getElementById('reseau-achat').value=ra; 
            if(cv) document.getElementById('crypto-vente').value=cv; 
            if(rv) document.getElementById('reseau-vente').value=rv; 
            if(ov) document.getElementById('operateur-vente').value=ov; 
            if(pv) document.getElementById('portefeuille-vente').value=pv; 
            afficherFraisReseauAchat(); afficherFraisReseauVente(); 
            mettreAJourChampAdresseVente();
        }
        
        function mettreAJourReseaux(t){ 
            const c=document.getElementById(`crypto-${t}`)?.value; 
            const s=document.getElementById(`reseau-${t}`); 
            if(!s||!donnees.reseaux) return; 
            const av=s.value; 
            const rf=donnees.reseaux.filter(r=>r.crypto===c); 
            s.innerHTML=rf.map(r=>`<option value="${echapperHTML(r.nom)}" data-frais="${r.fraisReseau||0}">${echapperHTML(r.nom)}</option>`).join(''); 
            if(av&&Array.from(s.options).some(o=>o.value===av)) s.value=av; 
            if(t==='achat'){ estimerAchat(); afficherFraisReseauAchat(); }else{ estimerVente(); afficherFraisReseauVente(); mettreAJourChampAdresseVente(); } 
        }
        
        function afficherFraisReseauAchat(){ 
            const s=document.getElementById('reseau-achat'); 
            const f=document.getElementById('frais-reseau-achat-affichage'); 
            const c=document.getElementById('crypto-achat')?.value; 
            const mt=document.getElementById('message-trx-special'); 
            if(s&&f){ const so=s.options[s.selectedIndex]; if(so) f.innerHTML=`(frais réseau: ${so.dataset.frais||'0'}%)`; } 
            if(mt) mt.style.display=(c==='TRX'&&s?.value==='TRC20')?'block':'none'; 
        }
        
        function afficherFraisReseauVente(){ 
            const s=document.getElementById('reseau-vente'); 
            const f=document.getElementById('frais-reseau-vente-affichage'); 
            if(s&&f){ const so=s.options[s.selectedIndex]; if(so) f.innerHTML=`(frais réseau: ${so.dataset.frais||'0'}%)`; } 
        }
        
        function mettreAJourLimiteAchat(){ 
            const c=document.getElementById('crypto-achat')?.value; 
            const min=c==='TRX'?(donnees.limites?.minAchatTRX||5000):(donnees.limites?.minAchat||2000); 
            const max=donnees.limites?.maxAchat||100000; 
            const i=document.getElementById('montant-achat'); 
            const ls=document.getElementById('montant-limite-achat'); 
            const la=document.getElementById('limite-affichee-achat'); 
            const mins=document.getElementById('min-affichage-achat'); 
            const maxs=document.getElementById('max-affichage-achat'); 
            if(i){ i.min=min; i.max=max; if(i.value<min) i.value=min; if(i.value>max) i.value=max; } 
            if(ls) ls.innerHTML=`(Min: ${min.toLocaleString()} Ar - Max: ${max.toLocaleString()} Ar)`; 
            if(la) la.innerHTML=`${min.toLocaleString()} Ar - ${max.toLocaleString()} Ar`; 
            if(mins) mins.innerHTML=min.toLocaleString(); 
            if(maxs) maxs.innerHTML=max.toLocaleString(); 
            verifierLimitesAchat(); estimerAchat(); 
        }
        
        function verifierLimitesAchat(){ 
            const m=parseFloat(document.getElementById('montant-achat')?.value)||0; 
            const c=document.getElementById('crypto-achat')?.value; 
            const min=c==='TRX'?(donnees.limites?.minAchatTRX||5000):(donnees.limites?.minAchat||2000); 
            const max=donnees.limites?.maxAchat||100000; 
            const e=document.getElementById('limite-error-achat'); 
            const b=document.getElementById('btn-confirmer-achat'); 
            if(m<min||m>max){ e.classList.add('show'); if(b) b.disabled=true; return false; }else{ e.classList.remove('show'); if(b) b.disabled=false; return true; } 
        }
        
        function verifierLimitesVente(){ 
            const m=parseFloat(document.getElementById('montant-vente')?.value)||0; 
            const c=document.getElementById('crypto-vente')?.value; 
            const t=donnees.taux[c]?.prixMGA||0; 
            const va=m*t; 
            const min=donnees.limites?.minVente||2000; 
            const max=donnees.limites?.maxVente||100000; 
            const e=document.getElementById('limite-error-vente'); 
            const b=document.getElementById('btn-confirmer-vente'); 
            if(va<min||va>max){ e.classList.add('show'); if(b) b.disabled=true; return false; }else{ e.classList.remove('show'); if(b) b.disabled=false; return true; } 
        }
        
        function afficherReponseVente(){ 
            const s=document.getElementById('portefeuille-vente'); 
            const r=document.getElementById('reponse-portefeuille-vente'); 
            if(s&&r&&donnees.portefeuilles){ const p=donnees.portefeuilles.find(p=>p.nom===s.value); if(p) r.textContent=echapperHTML(p.reponse||'Aucune description'); } 
        }

        function estimerAchat(){ 
            const m=parseFloat(document.getElementById('montant-achat')?.value)||0; 
            const c=document.getElementById('crypto-achat')?.value; 
            const f=donnees.frais?.achat||1.5; 
            const t=donnees.taux[c]?.prixMGA||0; 
            cryptoAchat=c; 
            const fe=m*(f/100); 
            const map=m-fe; 
            const e=t>0?map/t:0; 
            montantRecuAchat=e; 
            document.getElementById('estimation-achat-container').innerHTML=`<div><span class="estimated-label">Vous recevez:</span><span class="estimated-amount">${e.toFixed(4)} ${echapperHTML(c)}</span></div>`; 
            verifierLimitesAchat(); 
        }
        
        function estimerVente(){ 
            const m=parseFloat(document.getElementById('montant-vente')?.value)||0; 
            const c=document.getElementById('crypto-vente')?.value; 
            const rs=document.getElementById('reseau-vente'); 
            const fr=rs?.selectedOptions[0]?.dataset?.frais?parseFloat(rs.selectedOptions[0].dataset.frais):0; 
            const ft=donnees.frais?.vente||2.0; 
            const ftot=ft+fr; 
            const t=donnees.taux[c]?.prixMGA||0; 
            cryptoVente=c; 
            const mb=m*t; 
            const fe=mb*(ftot/100); 
            const mn=mb-fe; 
            montantRecuVente=mn; 
            document.getElementById('estimation-vente-container').innerHTML=`<div><span class="estimated-label">Vous recevez:</span><span class="estimated-amount">${mn.toLocaleString()} Ar</span></div>`; 
            verifierLimitesVente(); 
        }

        function verifierPause(){ 
            const pa=donnees.pause?.achat; 
            const pv=donnees.pause?.vente; 
            const ac=document.getElementById('achat-content'); 
            const vc=document.getElementById('vente-content'); 
            const pma=document.getElementById('pause-message-achat'); 
            const pmv=document.getElementById('pause-message-vente'); 
            if(ac&&pma){ ac.style.display=pa?'none':'block'; pma.style.display=pa?'flex':'none'; } 
            if(vc&&pmv){ vc.style.display=pv?'none':'block'; pmv.style.display=pv?'flex':'none'; } 
        }

        async function connexion(){
            const e = document.getElementById('email-connexion').value.trim();
            const p = document.getElementById('password-connexion').value.trim();
            if(!e||!p){ afficherErreur('Email et mot de passe requis'); return; }
            try{
                await appliquerPersistanceAuth();
                await auth.signInWithEmailAndPassword(e,p);
                hideAuthModal();
            } catch(error){ afficherErreur(error.message); }
        }

        async function inscription(){
            const n = document.getElementById('nom-inscription').value.trim();
            const e = document.getElementById('email-inscription').value.trim();
            const p = document.getElementById('password-inscription').value.trim();
            const parrainCode = nettoyerCodeParrain(document.getElementById('parrain-id')?.value);
            if(!n||!e||!p){ afficherErreur('Tous les champs sont requis'); return; }
            if(p.length<6){ afficherErreur('Mot de passe trop court (6 caractères minimum)'); return; }
            try{
                await appliquerPersistanceAuth();
                pendingReferralUid = parrainCode || '';
                const uc = await auth.createUserWithEmailAndPassword(e,p);
                await uc.user.updateProfile({displayName:n});
                hideAuthModal();
                alert(`Inscription réussie ! ${parrainCode ? 'Code parrain enregistré.' : ''}\n\nAjoutez vos numéros dans votre profil pour commencer à échanger.`);
            } catch(error){
                pendingReferralUid = '';
                afficherErreur(error.message);
            }
        }

        function deconnexion(){
            if(confirm('Êtes-vous sûr de vouloir vous déconnecter ?')){
                auth.signOut().then(()=>{
                    utilisateurCourant = null;
                    sessionValide = false;
                    monUid = null;
                    adressesUtilisateur = {};
                    toursGratuits = 0;
                    filleulsCount = 0;
                    nettoyerSessionsLegacy();
                    showLandingPage();
                    mettreAJourAffichage();
                });
            }
        }

        function showAuthModal(){ 
            const urlParams = new URLSearchParams(window.location.search);
            const refId = nettoyerCodeParrain(urlParams.get('ref'));
            const parrainInput = document.getElementById('parrain-id');
            if(refId && parrainInput) {
                parrainInput.value = refId;
                setTimeout(() => {
                    const msgDiv = document.createElement('div');
                    msgDiv.style.cssText = 'background:rgba(16,185,129,0.2); color:#10B981; padding:10px; border-radius:16px; margin-top:10px; font-size:0.8rem; text-align:center;';
                    msgDiv.innerHTML = '<i class="fas fa-check-circle"></i> Code parrain détecté automatiquement !';
                    const parent = parrainInput.parentElement;
                    if(parent && !parent.querySelector('.parrain-msg')) {
                        msgDiv.classList.add('parrain-msg');
                        parent.appendChild(msgDiv);
                        setTimeout(() => msgDiv.remove(), 3000);
                    }
                }, 500);
            } else if(parrainInput) {
                parrainInput.value = '';
            }
            document.getElementById('modal-auth').classList.add('active'); 
            switchAuthMode('inscription');
        }
        function hideAuthModal(){ document.getElementById('modal-auth').classList.remove('active'); document.getElementById('erreur-auth').classList.remove('show'); }
        function switchAuthMode(m){ modeAuth=m; document.getElementById('connexion-form').style.display=m==='connexion'?'block':'none'; document.getElementById('inscription-form').style.display=m==='inscription'?'block':'none'; const bc=document.getElementById('btn-connexion-mode'); const bi=document.getElementById('btn-inscription-mode'); const ba=document.getElementById('btn-auth'); if(m==='connexion'){ bc.className='btn btn-success'; bi.className='btn'; ba.innerHTML='<i class="fas fa-check"></i> Se connecter'; }else{ bc.className='btn'; bi.className='btn btn-success'; ba.innerHTML='<i class="fas fa-user-plus"></i> S\'inscrire'; } }
        function authentifier(){ if(modeAuth==='connexion') connexion(); else inscription(); }
        function afficherErreur(m){ document.getElementById('erreur-texte').textContent=m; document.getElementById('erreur-auth').classList.add('show'); }
        function showLandingPage(){ document.getElementById('landing-page').style.display='block'; document.querySelectorAll('.platform-section').forEach(s=>s.classList.remove('active')); document.getElementById('bottom-nav').classList.remove('visible'); }
        function showPlatform(){ document.getElementById('landing-page').style.display='none'; document.getElementById('bottom-nav').classList.add('visible'); switchPlatformSection('accueil'); }

        async function verifierEmailEtNumero() {
            const email = document.getElementById('email-recuperation').value.trim();
            const erreurDiv = document.getElementById('erreur-recuperation');
            if(!email) {
                erreurDiv.textContent = 'Veuillez entrer votre email';
                erreurDiv.classList.add('show');
                return;
            }
            try {
                await auth.sendPasswordResetEmail(email);
                erreurDiv.classList.remove('show');
                alert(`Si un compte existe pour ${email}, un lien de réinitialisation a été envoyé.`);
                fermerModalMotDePasseOublie();
            } catch(error) {
                console.error(error);
                erreurDiv.textContent = 'Impossible d’envoyer le lien de réinitialisation';
                erreurDiv.classList.add('show');
            }
        }
        
        async function reinitialiserMotDePasse() {
            return verifierEmailEtNumero();
        }
        
        function retourEtape1() {
            document.getElementById('erreur-recuperation').classList.remove('show');
        }
        
        function ouvrirModalMotDePasseOublie() {
            document.getElementById('modal-motdepasse-oublie').classList.add('active');
            retourEtape1();
        }
        
        function fermerModalMotDePasseOublie() {
            document.getElementById('modal-motdepasse-oublie').classList.remove('active');
        }

        // ==================== ROUE DE LA FORTUNE ====================
        function dessinerRoue() {
            const canvas = document.getElementById('roue-canvas');
            if(!canvas) return;
            const ctx = canvas.getContext('2d');
            const centerX = canvas.width / 2;
            const centerY = canvas.height / 2;
            const radius = centerX;
            
            let tr = Array.isArray(donnees.roue) ? donnees.roue : (typeof donnees.roue === 'object' ? Object.values(donnees.roue) : []);
            tr = tr.filter(item => item !== null);
            lotsRoue = (tr && tr.length > 0) ? tr : lotsParDefaut;

            const totalLots = lotsRoue.length;
            const arcSize = (2 * Math.PI) / totalLots;
            const couleurs = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16'];

            ctx.clearRect(0, 0, canvas.width, canvas.height);

            for (let i = 0; i < totalLots; i++) {
                const angleStart = i * arcSize - Math.PI / 2;
                const angleEnd = angleStart + arcSize;

                ctx.beginPath();
                ctx.moveTo(centerX, centerY);
                ctx.arc(centerX, centerY, radius, angleStart, angleEnd);
                ctx.fillStyle = couleurs[i % couleurs.length];
                ctx.fill();
                ctx.lineWidth = 2;
                ctx.strokeStyle = '#1e1b4b';
                ctx.stroke();

                ctx.save();
                ctx.translate(centerX, centerY);
                ctx.rotate(angleStart + arcSize / 2);
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = 'white';
                ctx.font = 'bold 14px Inter';
                let nomCourt = lotsRoue[i].nom;
                if(nomCourt.length > 12) nomCourt = nomCourt.substring(0,10)+'..';
                ctx.fillText(nomCourt, radius - 20, 0);
                ctx.restore();
            }
        }

        function ouvrirModalRoue() {
            if(!utilisateurCourant) { showAuthModal(); return; }
            
            const aujourdhui = new Date().toLocaleDateString('fr-FR');
            const demandesArray = getDemandesTableau();
            
            const aTransactionAujourdhui = demandesArray.some(d => 
                d.userID === monUid && 
                d.statut === 'confirme' && 
                (d.type === 'ACHAT' || d.type === 'VENTE') &&
                new Date(d.date).toLocaleDateString('fr-FR') === aujourdhui
            );
            
            const aJoueAujourdhui = demandesArray.some(d => 
                d.userID === monUid && 
                d.type === 'BONUS' && 
                new Date(d.date).toLocaleDateString('fr-FR') === aujourdhui
            );

            const aTourGratuit = toursGratuits > 0;

            if(!aTransactionAujourdhui && !aTourGratuit) {
                alert('Vous devez avoir une transaction confirmée aujourd\'hui ou un tour gratuit pour jouer à la roue !');
                return;
            }
            if(aJoueAujourdhui && !aTourGratuit) {
                alert('Vous avez déjà joué aujourd\'hui. Revenez demain !');
                return;
            }
            
            document.getElementById('roue-jeu').style.display = 'block';
            document.getElementById('roue-resultat').style.display = 'none';
            document.getElementById('btn-tourner-roue').disabled = false;
            document.getElementById('btn-fermer-roue').style.display = 'block';
            document.getElementById('roue-element').style.transition = 'none';
            document.getElementById('roue-element').style.transform = 'rotate(0deg)';
            
            dessinerRoue();
            document.getElementById('modal-roue').classList.add('active');
        }

        function fermerModalRoue() { 
            document.getElementById('modal-roue').classList.remove('active');
            lotGagneInfo = null;
            document.getElementById('input-bonus-contact').value = '';
            document.getElementById('erreur-bonus').classList.remove('show');
        }

        async function tournerRoue() {
            document.getElementById('btn-tourner-roue').disabled = true;
            document.getElementById('btn-fermer-roue').style.display = 'none';
            try {
                const result = await callCloudFunction('playWheel');
                lotGagneInfo = result.lot;
                toursGratuits = result.toursGratuits || 0;
                mettreAJourAffichageAffiliation();
                const indexGagnant = Number.isInteger(result.index) ? result.index : (lotsRoue.findIndex((lot) => lot.id === result.lot?.id));
                const resolvedIndex = indexGagnant >= 0 ? indexGagnant : lotsRoue.length - 1;
                const totalLots = lotsRoue.length;
                const arcSizeDeg = 360 / totalLots;
                const angleCibleSection = 360 - (resolvedIndex * arcSizeDeg + arcSizeDeg / 2);
                const toursSupplementaires = 360 * 5;
                const angleFinal = toursSupplementaires + angleCibleSection;

                const wheel = document.getElementById('roue-element');
                wheel.style.transition = 'transform 4s cubic-bezier(0.17, 0.67, 0.12, 0.99)';
                wheel.style.transform = `rotate(${angleFinal}deg)`;

                setTimeout(() => { afficherResultatRoue(); }, 4500);
            } catch (error) {
                console.error(error);
                alert(error?.message || 'Impossible de lancer la roue pour le moment.');
                document.getElementById('btn-tourner-roue').disabled = false;
                document.getElementById('btn-fermer-roue').style.display = 'block';
            }
        }

        function afficherResultatRoue() {
            document.getElementById('roue-jeu').style.display = 'none';
            document.getElementById('roue-resultat').style.display = 'block';
            
            if (lotGagneInfo.type === 'rien' || lotGagneInfo.nom.toLowerCase().includes('merci') || lotGagneInfo.nom.toLowerCase().includes('retentez')) {
                document.getElementById('texte-resultat').innerHTML = `😢 Pas de chance cette fois !`;
                document.getElementById('texte-resultat').style.color = 'var(--danger)';
                document.getElementById('texte-instruction-bonus').textContent = `Vous êtes tombé sur : "${lotGagneInfo.nom}". Retentez votre chance demain !`;
                document.getElementById('input-bonus-contact').style.display = 'none';
                document.getElementById('btn-fermer-roue').style.display = 'block';
                const btnReclamer = document.querySelector('#roue-resultat .btn-confirm');
                if(btnReclamer) btnReclamer.style.display = 'none';
            } else {
                document.getElementById('texte-resultat').innerHTML = `🎉 Félicitations ! Vous avez gagné !`;
                document.getElementById('texte-resultat').style.color = 'var(--success)';
                document.getElementById('texte-instruction-bonus').textContent = `Lot : ${lotGagneInfo.nom}. Entrez vos informations de réception ci-dessous.`;
                const input = document.getElementById('input-bonus-contact');
                input.style.display = 'block';
                input.value = '';
                input.placeholder = lotGagneInfo.type === 'crypto' ? "Votre adresse Crypto (ex: wallet address)" : "Votre Numéro Mobile Money (MVola, Orange, Airtel)";
                const btnReclamer = document.querySelector('#roue-resultat .btn-confirm');
                if(btnReclamer) btnReclamer.style.display = 'block';
            }
        }
        
        async function reclamerBonus() {
            const contact = document.getElementById('input-bonus-contact').value.trim();
            const errDiv = document.getElementById('erreur-bonus');
            if (!contact) { errDiv.textContent = "Veuillez fournir votre information de réception."; errDiv.classList.add('show'); return; }
            try {
                const result = await callCloudFunction('claimWheelBonus', { contact });
                const demandesArray = getDemandesTableau();
                demandesArray.unshift(result.transaction);
                donnees.demandes = Object.fromEntries(demandesArray.filter(Boolean).map((item) => [item.id, item]));
                document.getElementById('roue-resultat').innerHTML = `<h3 style="color:var(--success);"><i class="fas fa-check-circle"></i> Demande envoyée !</h3><p style="color:var(--text-secondary); margin-top:10px;">L'administrateur va vérifier et valider votre gain.</p>`;
                setTimeout(() => { fermerModalRoue(); verifierAccesBonus(); switchPlatformSection('demandes'); mettreAJourMesDemandes(); }, 2000);
            } catch (error) {
                console.error(error);
                errDiv.textContent = error?.message || "Impossible d'envoyer la demande.";
                errDiv.classList.add('show');
            }
        }

        // ==================== FONCTIONS UTILITAIRES GÉNÉRALES ====================
        function echapperHTML(t) { if(!t) return ''; return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
        function genererIDStable(e,n) { const h=btoa(e+n).replace(/[^a-zA-Z0-9]/g,'').substring(0,8); return `TX-${h}-${Date.now().toString(36)}`; }
        async function hasherPIN(pin){ const salt=crypto.getRandomValues(new Uint8Array(16)); const saltHex=Array.from(salt).map(b=>b.toString(16).padStart(2,'0')).join(''); const data=new TextEncoder().encode(pin+saltHex); const hash=await crypto.subtle.digest('SHA-256',data); const hashHex=Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join(''); return {hash:hashHex,salt:saltHex}; }

        nettoyerSessionsLegacy();

        auth.onAuthStateChanged(async(fbUser)=>{
            if(fbUser){
                monUid = fbUser.uid;
                const userRef = database.ref(`donnees/utilisateurs/${monUid}`);
                const snapshot = await userRef.once('value');
                if(snapshot.exists()){
                    utilisateurCourant = snapshot.val();
                    if (utilisateurCourant.codePIN?.hash || utilisateurCourant.codePIN?.salt) {
                        try {
                            const migration = await callCloudFunction('migrateLegacyPin');
                            if (migration?.codePIN) utilisateurCourant.codePIN = migration.codePIN;
                        } catch (error) {
                            console.error('Migration PIN legacy impossible:', error);
                        }
                    }
                    utilisateurCourant.uid = monUid;
                    adressesUtilisateur = utilisateurCourant.adressesLiees || {};
                    toursGratuits = utilisateurCourant.toursGratuits || 0;
                    filleulsCount = utilisateurCourant.filleulsCount || 0;
                } else {
                    const profileResult = await callCloudFunction('ensureUserProfile', {
                        displayName: fbUser.displayName || fbUser.email.split('@')[0],
                        referralCode: pendingReferralUid || nettoyerCodeParrain(new URLSearchParams(window.location.search).get('ref'))
                    });
                    utilisateurCourant = profileResult.profile;
                    utilisateurCourant.uid = monUid;
                    adressesUtilisateur = {};
                    toursGratuits = 0;
                    filleulsCount = 0;
                }
                pendingReferralUid = '';
                sessionValide = true;
                mettreAJourAffichage();
                demarrerEcouteNumeros();
                demarrerEcouteAdresses();
                demarrerEcouteTransactionsUtilisateur();
                verifierAccesBonus();
                mettreAJourAffichageAffiliation();
                chargerDonnees();
                if(document.getElementById('landing-page').style.display !== 'none') showPlatform();
            } else {
                utilisateurCourant = null;
                sessionValide = false;
                monUid = null;
                adressesUtilisateur = {};
                toursGratuits = 0;
                filleulsCount = 0;
                ecouteNumerosActive = false;
                ecouteAdressesActive = false;
                ecouteTransactionsActive = false;
                nettoyerSessionsLegacy();
                mettreAJourAffichage();
            }
        });

        window.addEventListener('load',function(){ chargerDonnees(); console.log('🚀 Version optimisée - Transactions confirmées en temps réel - Cache activé'); });