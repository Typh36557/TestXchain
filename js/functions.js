// ============================================
// VARIABLES GLOBALES
// ============================================
let donnees = {
    portefeuilles: [], operateurs: [], cryptos: ["USDT","BTC","ETH","BNB","LTC","SOL","TRX","DOGE","MATIC","SUI","XRP","TON","USDC"],
    taux: {}, reseaux: [], frais: { achat: 1.5, vente: 2.0 }, pause: { achat: false, vente: false }, demandes: {}, news: [],
    tauxMode: 'auto', usdMGA: 4700,
    limites: { minAchat: 2000, minAchatTRX: 5000, maxAchat: 100000, minVente: 2000, maxVente: 100000 },
    messagesSpeciaux: { trx: "Frais réseau TRC20 : 3% ou -1 TRX si activation" },
    roue: [], roueActive: true
};

let adressesUtilisateur = {};
let toursGratuits = 0;
let filleulsCount = 0;
let transactionEnAttente = null;
let timerInterval = null;
let tempsRestant = 900;
let pinSetupValue = '', pinSetupConfirmValue = '', pinVerifValue = '';
let lotsRoue = [];
let lotGagneInfo = null;
let derniereSyncTaux = 0;
let ecouteNumerosActive = false;
let ecouteAdressesActive = false;
let adresseLieeSelectionnee = null;

// ============================================
// FONCTIONS UTILITAIRES
// ============================================
function echapperHTML(t) { if(!t) return ''; return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }

function genererIDStable(e,n) { const h=btoa(e+n).replace(/[^a-zA-Z0-9]/g,'').substring(0,8); return `TX-${h}-${Date.now().toString(36)}`; }

async function hasherPIN(pin){ const salt=crypto.getRandomValues(new Uint8Array(16)); const saltHex=Array.from(salt).map(b=>b.toString(16).padStart(2,'0')).join(''); const data=new TextEncoder().encode(pin+saltHex); const hash=await crypto.subtle.digest('SHA-256',data); const hashHex=Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join(''); return {hash:hashHex,salt:saltHex}; }

function getMinimumAchat(c){ return c==='TRX'?(donnees.limites?.minAchatTRX||5000):(donnees.limites?.minAchat||2000); }

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
    verifierAccesBonus();
}

function tronquerNom(nom) {
    if(!nom) return 'Utilisateur';
    const nomPropre = nom.trim().replace(/\s+/g, ' ');
    const mots = nomPropre.split(' ');
    if(mots.length <= 4) return nomPropre;
    return mots.slice(0, 4).join(' ');
}

function aNumeroApprouve() {
    const numeros = utilisateurCourant?.numeros || {};
    return Object.values(numeros).some(num => num.statut === 'approuve');
}

// ============================================
// SYNC TAUX BINANCE
// ============================================
async function getTauxMGA() { 
    try{ 
        const r=await fetch('https://api.exchangerate-api.com/v4/latest/USD'); 
        const d=await r.json(); 
        if(d.rates&&d.rates.MGA){ 
            donnees.usdMGA=d.rates.MGA; 
            return donnees.usdMGA; 
        } 
    }catch(e){} 
    return donnees.usdMGA||4700; 
}

async function syncBinance() {
    if(donnees.tauxMode !== 'auto') return;
    try{ 
        const tauxMGA=await getTauxMGA(); 
        const r=await fetch('https://api.binance.com/api/v3/ticker/price'); 
        const prices=await r.json(); 
        let updates={}; 
        Object.entries(pairesBinance).forEach(([crypto,paire])=>{ 
            if(crypto==='USDT') updates[`donnees/taux/${crypto}`]={prixUSD:1,prixMGA:tauxMGA,variation:'0',couleur:'positive',lastUpdate:new Date().toISOString(),source:'auto'}; 
            else{ 
                const ticker=prices.find(p=>p.symbol===paire); 
                if(ticker){ 
                    const pu=parseFloat(ticker.price); 
                    const pm=Math.round(pu*tauxMGA); 
                    const v=(Math.random()*4-2).toFixed(1); 
                    updates[`donnees/taux/${crypto}`]={prixUSD:pu,prixMGA:pm,variation:(v>0?'+':'')+v,couleur:v>=0?'positive':'negative',lastUpdate:new Date().toISOString(),source:'auto'}; 
                } 
            } 
        }); 
        await database.ref().update(updates); 
        const snap=await database.ref('donnees/taux').once('value');
        if(snap.val()) {
            donnees.taux=snap.val();
        }
        afficherTauxSimplifies();
        derniereSyncTaux = Date.now();
        const element = document.getElementById('taux-last-update');
        if(element) element.innerHTML = `Mise à jour: ${new Date().toLocaleTimeString()}`;
    } catch(e){ console.error(e); } 
}

async function syncBinanceManuel() {
    await syncBinance();
    alert('✅ Taux mis à jour !');
}

// ============================================
// CHARGEMENT DONNÉES FIREBASE
// ============================================
function obtenirDonneesParDefaut() {
    return {
        portefeuilles: [], operateurs: [], cryptos: ["USDT","BTC","ETH","BNB","LTC","SOL","TRX","DOGE","MATIC","SUI","XRP","TON","USDC"],
        reseaux: [], frais: { achat: 1.5, vente: 2.0 }, pause: { achat: false, vente: false }, taux: {}, demandes: {}, news: [],
        tauxMode: 'auto', usdMGA: 4700, limites: { minAchat: 2000, minAchatTRX: 5000, maxAchat: 100000, minVente: 2000, maxVente: 100000 },
        messagesSpeciaux: { trx: "Frais réseau TRC20 : 3% ou -1 TRX si activation" }, roue: lotsParDefaut, roueActive: true
    };
}

function chargerDonnees() {
    database.ref('donnees').once('value').then(s => {
        const data = s.val();
        if(data && Object.keys(data).length > 0){
            donnees = { ...obtenirDonneesParDefaut(), ...data };
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
            if(!donnees.demandes) donnees.demandes = {};
            if(donnees.roueActive === undefined) donnees.roueActive = true;
            donnees.portefeuilles = donnees.portefeuilles.map(p => ({ ...p, liaisonRequise: p.liaisonRequise || false }));
        } else {
            donnees = obtenirDonneesParDefaut();
            donnees.roueActive = true;
        }
        mettreAJourAffichage();
        afficherNews();
        afficherTauxSimplifies();
        demarrerSyncBinance();
    }).catch(e => { console.error(e); donnees = obtenirDonneesParDefaut(); mettreAJourAffichage(); });
}

function demarrerSyncBinance() {
    syncBinance();
    setInterval(syncBinance, 1800000);
}

// ============================================
// AFFICHAGE UI
// ============================================
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

// ============================================
// NAVIGATION
// ============================================
function showLandingPage(){ 
    document.getElementById('landing-page').style.display='block'; 
    document.querySelectorAll('.platform-section').forEach(s=>s.classList.remove('active')); 
    document.getElementById('bottom-nav').classList.remove('visible'); 
}

function showPlatform(){ 
    document.getElementById('landing-page').style.display='none'; 
    document.getElementById('bottom-nav').classList.add('visible'); 
    switchPlatformSection('accueil'); 
}

function scrollToTestimonials(){ document.getElementById('testimonials').scrollIntoView({behavior:'smooth'}); }

function showAuthModal(){ 
    const urlParams = new URLSearchParams(window.location.search);
    const refId = urlParams.get('ref');
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
    switchAuthMode('connexion');
}

function hideAuthModal(){ 
    document.getElementById('modal-auth').classList.remove('active'); 
    document.getElementById('erreur-auth').classList.remove('show');
    resetTurnstileWidgets();
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

// ============================================
// SÉLECTEURS ET FORMULAIRES
// ============================================
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

function afficherReponseVente(){ 
    const s=document.getElementById('portefeuille-vente'); 
    const r=document.getElementById('reponse-portefeuille-vente'); 
    if(s&&r&&donnees.portefeuilles){ const p=donnees.portefeuilles.find(p=>p.nom===s.value); if(p) r.textContent=echapperHTML(p.reponse||'Aucune description'); } 
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

// ============================================
// TRANSACTIONS (ACHAT/VENTE)
// ============================================
function estimerAchat(){ 
    const m=parseFloat(document.getElementById('montant-achat')?.value)||0; 
    const c=document.getElementById('crypto-achat')?.value; 
    const f=donnees.frais?.achat||1.5; 
    const t=donnees.taux[c]?.prixMGA||0; 
    const fe=m*(f/100); 
    const map=m-fe; 
    const e=t>0?map/t:0; 
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
    const mb=m*t; 
    const fe=mb*(ftot/100); 
    const mn=mb-fe; 
    document.getElementById('estimation-vente-container').innerHTML=`<div><span class="estimated-label">Vous recevez:</span><span class="estimated-amount">${mn.toLocaleString()} Ar</span></div>`; 
    verifierLimitesVente(); 
}

function verifierLimitesAchat(){ 
    const m=parseFloat(document.getElementById('montant-achat')?.value)||0; 
    const c=document.getElementById('crypto-achat')?.value; 
    const min=getMinimumAchat(c); 
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

function mettreAJourLimiteAchat(){ 
    const c=document.getElementById('crypto-achat')?.value; 
    const min=getMinimumAchat(c); 
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

function preparerConfirmation(type) {
    if(!sessionValide || !utilisateurCourant){ alert('Veuillez vous connecter'); showAuthModal(); return; }
    
    if(type === 'ACHAT'){
        const selectNumero = document.getElementById('numero-achat-select');
        if(!selectNumero || !selectNumero.value){ alert('Veuillez sélectionner un numéro à débiter'); return; }
        if(!verifierLimitesAchat()){ alert('Montant hors limites'); return; }
        const montant = parseFloat(document.getElementById('montant-achat').value);
        if(isNaN(montant) || montant <= 0){ alert('Montant invalide'); return; }
        transactionEnAttente = {
            type: 'ACHAT',
            montant: montant,
            operateur: document.getElementById('operateur-achat').value,
            crypto: document.getElementById('crypto-achat').value,
            reseau: document.getElementById('reseau-achat').value,
            portefeuille: document.getElementById('portefeuille-achat').value,
            adresse: document.getElementById('adresse-achat').value,
            numero: document.getElementById('numero-achat-select').value,
            nomNumero: document.getElementById('numero-achat-select').selectedOptions[0]?.dataset?.nom || '',
            montantRecu: parseFloat(document.getElementById('estimation-achat-container').querySelector('.estimated-amount')?.textContent || '0')
        };
    } else {
        const selectNumero = document.getElementById('numero-vente-select');
        if(!selectNumero || !selectNumero.value){ alert('Veuillez sélectionner un numéro à créditer'); return; }
        if(!verifierLimitesVente()){ alert('Montant hors limites'); return; }
        const montant = parseFloat(document.getElementById('montant-vente').value);
        if(isNaN(montant) || montant <= 0){ alert('Montant invalide'); return; }
        const portefeuilleNom = document.getElementById('portefeuille-vente')?.value;
        const portefeuille = donnees.portefeuilles?.find(p => p.nom === portefeuilleNom);
        const adresseUtilisee = (portefeuille?.liaisonRequise && adresseLieeSelectionnee) ? adresseLieeSelectionnee : null;
        transactionEnAttente = {
            type: 'VENTE',
            montant: montant,
            crypto: document.getElementById('crypto-vente').value,
            reseau: document.getElementById('reseau-vente').value,
            operateur: document.getElementById('operateur-vente').value,
            portefeuille: portefeuilleNom,
            numero: document.getElementById('numero-vente-select').value,
            nomNumero: document.getElementById('numero-vente-select').selectedOptions[0]?.dataset?.nom || '',
            montantRecu: parseFloat(document.getElementById('estimation-vente-container').querySelector('.estimated-amount')?.textContent?.replace(/[^\d]/g, '') || '0'),
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

async function creerDemande(){
    if(!transactionEnAttente || !utilisateurCourant) return;
    const demande = { id: genererIDStable(utilisateurCourant.email, Date.now().toString()), type: transactionEnAttente.type, date: new Date().toISOString(), utilisateur: utilisateurCourant.nom, email: utilisateurCourant.email, userID: monUid, statut: 'en_attente', txid: transactionEnAttente.txid, ...transactionEnAttente };
    const demandesArray = getDemandesTableau();
    demandesArray.unshift(demande);
    sauvegarderDemandes(demandesArray);
    ouvrirModalSucces(demande);
    transactionEnAttente = null;
    adresseLieeSelectionnee = null;
    setTimeout(() => { 
        switchPlatformSection('demandes'); 
        mettreAJourMesDemandes();
        verifierAccesBonus();
    }, 2000);
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

// ============================================
// PIN MANAGEMENT
// ============================================
function gererPIN(){ if(!sessionValide || !utilisateurCourant){ showAuthModal(); return; } ouvrirModalPIN(); }

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
function selectionnerCasePIN(idx){}

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
    const inputId = document.getElementById('reset-pin-id').value.trim();
    if(!inputId) { document.getElementById('reset-pin-error').textContent = 'Veuillez entrer votre ID'; document.getElementById('reset-pin-error').classList.add('show'); return; }
    if(inputId !== utilisateurCourant.id) { document.getElementById('reset-pin-error').textContent = 'ID incorrect'; document.getElementById('reset-pin-error').classList.add('show'); return; }
    try {
        await database.ref(`donnees/utilisateurs/${monUid}/codePIN`).set({ actif: false, bloque: false, tentativeEchouees: 0, hash: null, salt: null });
        if(utilisateurCourant.codePIN) { utilisateurCourant.codePIN.actif = false; utilisateurCourant.codePIN.bloque = false; }
        alert('✅ Code PIN réinitialisé ! Veuillez configurer un nouveau code.');
        document.getElementById('pin-reset').style.display = 'none';
        ouvrirModalPIN();
    } catch(e) { console.error(e); document.getElementById('reset-pin-error').textContent = 'Erreur serveur'; document.getElementById('reset-pin-error').classList.add('show'); }
}

async function sauvegarderPIN(){
    if(pinSetupValue.length !== 6){ document.getElementById('pin-setup-error').textContent = 'Le code PIN doit contenir 6 chiffres'; document.getElementById('pin-setup-error').classList.add('show'); return; }
    if(pinSetupValue !== pinSetupConfirmValue){ document.getElementById('pin-setup-error').textContent = 'Les codes PIN ne correspondent pas'; document.getElementById('pin-setup-error').classList.add('show'); return; }
    try {
        const {hash, salt} = await hasherPIN(pinSetupValue);
        const updates = { [`donnees/utilisateurs/${monUid}/codePIN/hash`]: hash, [`donnees/utilisateurs/${monUid}/codePIN/salt`]: salt, [`donnees/utilisateurs/${monUid}/codePIN/actif`]: true, [`donnees/utilisateurs/${monUid}/codePIN/tentativeEchouees`]: 0, [`donnees/utilisateurs/${monUid}/codePIN/bloque`]: false };
        await database.ref().update(updates);
        if(utilisateurCourant) { utilisateurCourant.codePIN = { hash, salt, actif: true, tentativeEchouees: 0, bloque: false }; }
        alert('✅ Code PIN enregistré avec succès !');
        fermerModalPIN();
        mettreAJourProfil();
    } catch(error){ console.error(error); alert('Erreur lors de l\'enregistrement du PIN'); }
}

async function verifierPIN(){
    if(pinVerifValue.length !== 6){ document.getElementById('pin-error').textContent = 'Code PIN invalide (6 chiffres requis)'; document.getElementById('pin-error').classList.add('show'); return; }
    if(!utilisateurCourant || !utilisateurCourant.codePIN || !utilisateurCourant.codePIN.actif){ alert('Code PIN non configuré'); fermerModalPIN(); return; }
    const storedHash = utilisateurCourant.codePIN.hash;
    const salt = utilisateurCourant.codePIN.salt;
    const data = new TextEncoder().encode(pinVerifValue + salt);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('');
    if(hashHex === storedHash){
        document.getElementById('pin-error').classList.remove('show');
        await database.ref(`donnees/utilisateurs/${monUid}/codePIN/tentativeEchouees`).set(0);
        if(utilisateurCourant.codePIN) utilisateurCourant.codePIN.tentativeEchouees = 0;
        fermerModalPIN();
        creerDemande();
    } else {
        let tentativas = (utilisateurCourant.codePIN.tentativeEchouees || 0) + 1;
        await database.ref(`donnees/utilisateurs/${monUid}/codePIN/tentativeEchouees`).set(tentativas);
        if(utilisateurCourant.codePIN) utilisateurCourant.codePIN.tentativeEchouees = tentativas;
        if(tentativas >= 3){
            await database.ref(`donnees/utilisateurs/${monUid}/codePIN/bloque`).set(true);
            if(utilisateurCourant.codePIN) utilisateurCourant.codePIN.bloque = true;
            alert('Code PIN bloqué après 3 tentatives échouées. Contactez l\'administrateur.');
            fermerModalPIN();
        } else {
            document.getElementById('pin-error').textContent = `Code PIN incorrect. Tentatives restantes: ${3 - tentativas}`;
            document.getElementById('pin-error').classList.add('show');
            document.getElementById('pin-tentatives').textContent = `Tentatives restantes: ${3 - tentativas}`;
            pinVerifValue = '';
            mettreAJourAffichagePINVerification();
        }
    }
}

// ============================================
// GESTION NUMEROS
// ============================================
async function ajouterNumero() {
    if(!utilisateurCourant || !monUid){ showAuthModal(); return; }
    const nom = document.getElementById('nouveau-nom').value.trim();
    const numero = document.getElementById('nouveau-numero').value.trim();
    if(!nom || !numero){ alert('Veuillez remplir tous les champs'); return; }
    const numerosActuels = utilisateurCourant.numeros || {};
    if(Object.keys(numerosActuels).length >= 3){ alert('Limite de 3 numéros atteinte'); return; }
    const idNumero = Date.now().toString();
    const nouveauNumero = { nom: nom, numero: numero, statut: 'en_attente', dateAjout: new Date().toISOString() };
    const chemin = `donnees/utilisateurs/${monUid}/numeros/${idNumero}`;
    try {
        await database.ref(chemin).set(nouveauNumero);
        document.getElementById('nouveau-nom').value = '';
        document.getElementById('nouveau-numero').value = '';
        alert('Numéro ajouté ! En attente d\'approbation par l\'administrateur.');
    } catch(error) { console.error(error); alert('Erreur lors de l\'ajout du numéro'); }
}

function mettreAJourNumerosUtilisateur() {
    const liste = document.getElementById('liste-numeros-utilisateur');
    if(!liste) return;
    const numeros = utilisateurCourant?.numeros || {};
    if(Object.keys(numeros).length === 0){ liste.innerHTML = '<div class="activity-item">Aucun numéro</div>'; return; }
    liste.innerHTML = Object.entries(numeros).map(([id, num]) => `<div class="numero-item"><div class="numero-info"><div class="numero-nom">${echapperHTML(num.nom)}</div><div class="numero-value">${echapperHTML(num.numero)}</div></div><div class="numero-status status-${echapperHTML(num.statut)}">${num.statut === 'en_attente' ? 'En attente' : (num.statut === 'approuve' ? 'Approuvé' : 'Rejeté')}</div></div>`).join('');
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

// ==========================================
// GESTION ADRESSES LIEES
// ==========================================
function ouvrirModalAjoutAdresse() {
    if(!utilisateurCourant || !monUid){ showAuthModal(); return; }
    const cryptoSelect = document.getElementById('nouvelle-adresse-crypto');
    if(cryptoSelect && donnees.cryptos) {
        cryptoSelect.innerHTML = donnees.cryptos.map(c => `<option value="${echapperHTML(c)}">${echapperHTML(c)}</option>`).join('');
    }
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
    
    const tousUtilisateurs = await database.ref('donnees/utilisateurs').once('value');
    const users = tousUtilisateurs.val() || {};
    let adresseExistante = false;
    
    for(const [uid, userData] of Object.entries(users)) {
        if(userData.adressesLiees) {
            for(const [addrId, addr] of Object.entries(userData.adressesLiees)) {
                if(addr.adresse === adresse && addr.crypto === crypto && addr.reseau === reseau) {
                    if(uid !== monUid) { adresseExistante = true; break; }
                }
            }
        }
        if(adresseExistante) break;
    }
    
    if(adresseExistante) {
        document.getElementById('erreur-adresse').textContent = `Cette adresse est déjà utilisée par un autre utilisateur pour ${crypto}/${reseau}`;
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
    try {
        await database.ref(`donnees/utilisateurs/${monUid}/adressesLiees/${idAdresse}`).set(nouvelleAdresse);
        fermerModalAjoutAdresse();
        alert('✅ Adresse enregistrée avec succès !');
    } catch(error) { console.error(error); alert('Erreur lors de l\'enregistrement'); }
}

async function supprimerAdresse(id) {
    if(!confirm('Supprimer cette adresse ?')) return;
    try { await database.ref(`donnees/utilisateurs/${monUid}/adressesLiees/${id}`).remove(); alert('✅ Adresse supprimée'); } 
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

// ============================================
// DEMANDES
// ============================================
function mettreAJourMesDemandes(){ 
    const l=document.getElementById('mes-demandes-liste'); 
    if(!l) return; 
    if(!utilisateurCourant){ l.innerHTML='<div class="activity-item">Connectez-vous</div>'; return; } 
    const demandesArray = getDemandesTableau();
    const m=demandesArray.filter(d=>d.userID===monUid).sort((a,b)=>new Date(b.date)-new Date(a.date)); 
    if(m.length===0){ l.innerHTML='<div class="activity-item">Aucune demande</div>'; return; } 
    l.innerHTML=m.map(d=>`<li class="activity-item" onclick="ouvrirRecu('${echapperHTML(d.id)}')"><div class="activity-left"><div class="activity-icon ${echapperHTML(d.type)}"><i class="fas ${d.type==='ACHAT'?'fa-arrow-down':(d.type==='VENTE'?'fa-arrow-up':'fa-gift')}"></i></div><div class="activity-info"><h4>${echapperHTML(d.type)} ${d.crypto ? echapperHTML(d.crypto) : ''}</h4><div class="activity-date">${echapperHTML(new Date(d.date).toLocaleString())}</div></div></div><div><div class="activity-amount">${d.type==='ACHAT'?d.montant.toLocaleString()+' Ar':(d.type==='VENTE'?d.montant+' '+d.crypto:'Gain')}</div><div class="activity-status status-${echapperHTML(d.statut)}">${echapperHTML(d.statut)}</div></div></li>`).join(''); 
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
function fermerDetailsDemande(){ document.getElementById('modal-details-demande').classList.remove('active'); }

// ============================================
// ACTIVITES RECENTES
// ============================================
let dernierRafraichissementDemandes = 0;

function rafraichirDemandesOptimise() {
    if(!monUid) return;
    const maintenant = Date.now();
    if(maintenant - dernierRafraichissementDemandes < 60000) return;
    dernierRafraichissementDemandes = maintenant;
    
    database.ref('donnees/demandes').orderByChild('userID').equalTo(monUid).once('value').then(snap => {
        if(snap.exists()) {
            donnees.demandes = snap.val();
            mettreAJourMesDemandes();
            verifierAccesBonus();
        }
    }).catch(e => console.error(e));
    
    database.ref('donnees/demandes').limitToLast(10).once('value').then(snap => {
        if(snap.exists()) {
            const toutesDemandes = snap.val();
            const demandesRecentes = Object.values(toutesDemandes).filter(d => d.statut === 'confirme').slice(0,5);
            const l = document.getElementById('recent-activity');
            if(l && demandesRecentes.length > 0) {
                l.innerHTML = demandesRecentes.map(d => `<li class="activity-item"><div class="activity-left"><div class="activity-icon ${echapperHTML(d.type)}"><i class="fas ${d.type==='ACHAT'?'fa-arrow-down':(d.type==='VENTE'?'fa-arrow-up':'fa-gift')}"></i></div><div class="activity-info"><h4>${echapperHTML(d.type)} ${d.crypto ? echapperHTML(d.crypto) : ''}</h4><div class="activity-date">${echapperHTML(new Date(d.date).toLocaleString())}</div></div></div><div><div class="activity-amount">${d.type==='ACHAT'?d.montant.toLocaleString()+' Ar':(d.type==='VENTE'?d.montant+' '+d.crypto:'Lot Gagné')}</div><div class="activity-status status-${echapperHTML(d.statut)}">${echapperHTML(d.statut)}</div></div></li>`).join('');
            }
        }
    }).catch(e => console.error(e));
}

// ============================================
// AFFILIATION
// ============================================
function mettreAJourAffichageAffiliation() {
    const affiliateCard = document.getElementById('affiliate-card');
    if(!utilisateurCourant || !monUid) {
        if(affiliateCard) affiliateCard.style.display = 'none';
        return;
    }
    if(affiliateCard) affiliateCard.style.display = 'block';
    const refCode = utilisateurCourant.id || monUid.substring(0,8);
    const urlParrainage = `https://typh-xchain.site/?ref=${refCode}`;
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
    if(!parrainId) return;
    const parrainRef = database.ref(`donnees/utilisateurs/${parrainId}`);
    const snapshot = await parrainRef.once('value');
    const parrainData = snapshot.val();
    if(parrainData) {
        const nouveauxTours = (parrainData.toursGratuits || 0) + 1;
        const nouveauxFilleuls = (parrainData.filleulsCount || 0) + 1;
        await parrainRef.update({ toursGratuits: nouveauxTours, filleulsCount: nouveauxFilleuls });
        if(monUid === parrainId) {
            toursGratuits = nouveauxTours;
            filleulsCount = nouveauxFilleuls;
            mettreAJourAffichageAffiliation();
            verifierAccesBonus();
        }
    }
}

async function verifierParrainageEtAjouterTour(uid) {
    const userRef = database.ref(`donnees/utilisateurs/${uid}`);
    const snapshot = await userRef.once('value');
    const userData = snapshot.val();
    if(userData && userData.parrainId && userData.parrainId !== '') {
        const parrainId = userData.parrainId;
        const numeros = userData.numeros || {};
        const aNumeroApprouve = Object.values(numeros).some(n => n.statut === 'approuve');
        if(aNumeroApprouve && !userData.bonusParrainageDonne) {
            await ajouterTourGratuit(parrainId);
            await userRef.update({ bonusParrainageDonne: true });
        }
    }
}

// ============================================
// REINITIALISATION MOT DE PASSE
// ============================================
let utilisateurRecuperation = null;

async function verifierEmailEtNumero() {
    const email = document.getElementById('email-recuperation').value.trim();
    const numero = document.getElementById('numero-recuperation').value.trim();
    const erreurDiv = document.getElementById('erreur-recuperation');
    
    if(!email || !numero) {
        erreurDiv.textContent = 'Veuillez entrer votre email et numéro';
        erreurDiv.classList.add('show');
        return;
    }
    
    try {
        const snapshot = await database.ref('donnees/utilisateurs').once('value');
        const users = snapshot.val() || {};
        
        let userTrouve = null;
        let uidTrouve = null;
        
        for(const [uid, userData] of Object.entries(users)) {
            if(userData.email === email) {
                if(userData.numeros) {
                    const numerosApprouves = Object.values(userData.numeros).filter(n => n.statut === 'approuve');
                    const numeroTrouve = numerosApprouves.some(n => n.numero === numero);
                    if(numeroTrouve) {
                        userTrouve = userData;
                        uidTrouve = uid;
                        break;
                    }
                }
            }
        }
        
        if(userTrouve && uidTrouve) {
            utilisateurRecuperation = { ...userTrouve, uid: uidTrouve };
            document.getElementById('email-affiche').textContent = email;
            document.getElementById('etape-1-mdp').style.display = 'none';
            document.getElementById('etape-2-mdp').style.display = 'block';
            erreurDiv.classList.remove('show');
        } else {
            erreurDiv.textContent = 'Email ou numéro non reconnu. Vérifiez vos informations.';
            erreurDiv.classList.add('show');
        }
    } catch(error) {
        console.error(error);
        erreurDiv.textContent = 'Erreur lors de la vérification';
        erreurDiv.classList.add('show');
    }
}

async function reinitialiserMotDePasse() {
    const nouveauMdp = document.getElementById('nouveau-motdepasse').value;
    const confirmerMdp = document.getElementById('confirmer-motdepasse').value;
    const erreurDiv = document.getElementById('erreur-nouveau-mdp');
    
    if(!nouveauMdp || nouveauMdp.length < 6) {
        erreurDiv.textContent = 'Mot de passe doit contenir au moins 6 caractères';
        erreurDiv.classList.add('show');
        return;
    }
    
    if(nouveauMdp !== confirmerMdp) {
        erreurDiv.textContent = 'Les mots de passe ne correspondent pas';
        erreurDiv.classList.add('show');
        return;
    }
    
    if(!utilisateurRecuperation || !utilisateurRecuperation.email) {
        erreurDiv.textContent = 'Session expirée, veuillez recommencer';
        erreurDiv.classList.add('show');
        return;
    }
    
    try {
        const user = auth.currentUser;
        if(user && user.email === utilisateurRecuperation.email) {
            await user.updatePassword(nouveauMdp);
            alert('✅ Mot de passe modifié avec succès !');
        } else {
            await auth.sendPasswordResetEmail(utilisateurRecuperation.email);
            alert(`Un lien de réinitialisation a été envoyé à ${utilisateurRecuperation.email}. Veuillez vérifier votre boîte mail.`);
        }
        fermerModalMotDePasseOublie();
        utilisateurRecuperation = null;
    } catch(error) {
        console.error(error);
        erreurDiv.textContent = error.message || 'Erreur lors de la réinitialisation';
        erreurDiv.classList.add('show');
    }
}

function retourEtape1() {
    document.getElementById('etape-1-mdp').style.display = 'block';
    document.getElementById('etape-2-mdp').style.display = 'none';
    document.getElementById('erreur-recuperation').classList.remove('show');
    document.getElementById('erreur-nouveau-mdp').classList.remove('show');
    utilisateurRecuperation = null;
}

function ouvrirModalMotDePasseOublie() {
    document.getElementById('modal-motdepasse-oublie').classList.add('active');
    retourEtape1();
}

function fermerModalMotDePasseOublie() {
    document.getElementById('modal-motdepasse-oublie').classList.remove('active');
    utilisateurRecuperation = null;
}

// ============================================
// ÉCOUTEURS FIREBASE
// ============================================
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