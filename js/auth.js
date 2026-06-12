// ============================================
// VARIABLES GLOBALES AUTH
// ============================================
let utilisateurCourant = null;
let monUid = null;
let sessionValide = false;
let modeAuth = 'connexion';
let turnstileInscriptionToken = null;
let turnstileConnexionToken = null;

// ============================================
// TURNSTILE CALLBACKS
// ============================================
function onInscriptionTurnstileSuccess(token) {
    turnstileInscriptionToken = token;
    const statusDiv = document.getElementById('turnstile-inscription-status');
    if(statusDiv) {
        statusDiv.innerHTML = '<i class="fas fa-check-circle" style="color:#10B981;"></i> Vérification humaine réussie';
        statusDiv.style.color = '#10B981';
    }
    const btnAuth = document.getElementById('btn-auth');
    if(btnAuth) btnAuth.disabled = false;
}

function onInscriptionTurnstileExpired() {
    turnstileInscriptionToken = null;
    const statusDiv = document.getElementById('turnstile-inscription-status');
    if(statusDiv) {
        statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Validation expirée, veuillez refaire la vérification';
        statusDiv.style.color = '#F59E0B';
    }
    const btnAuth = document.getElementById('btn-auth');
    if(btnAuth) btnAuth.disabled = true;
}

function onInscriptionTurnstileError(error) {
    turnstileInscriptionToken = null;
    const statusDiv = document.getElementById('turnstile-inscription-status');
    if(statusDiv) {
        statusDiv.innerHTML = '<i class="fas fa-exclamation-circle"></i> Erreur de vérification, veuillez réessayer';
        statusDiv.style.color = '#EF4444';
    }
    const btnAuth = document.getElementById('btn-auth');
    if(btnAuth) btnAuth.disabled = true;
}

function onConnexionTurnstileSuccess(token) {
    turnstileConnexionToken = token;
    const statusDiv = document.getElementById('turnstile-connexion-status');
    if(statusDiv) {
        statusDiv.innerHTML = '<i class="fas fa-check-circle" style="color:#10B981;"></i> Vérification humaine réussie';
        statusDiv.style.color = '#10B981';
    }
    const btnAuth = document.getElementById('btn-auth');
    if(btnAuth) btnAuth.disabled = false;
}

function onConnexionTurnstileExpired() {
    turnstileConnexionToken = null;
    const statusDiv = document.getElementById('turnstile-connexion-status');
    if(statusDiv) {
        statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Validation expirée, veuillez refaire la vérification';
        statusDiv.style.color = '#F59E0B';
    }
    const btnAuth = document.getElementById('btn-auth');
    if(btnAuth) btnAuth.disabled = true;
}

function onConnexionTurnstileError(error) {
    turnstileConnexionToken = null;
    const statusDiv = document.getElementById('turnstile-connexion-status');
    if(statusDiv) {
        statusDiv.innerHTML = '<i class="fas fa-exclamation-circle"></i> Erreur de vérification, veuillez réessayer';
        statusDiv.style.color = '#EF4444';
    }
    const btnAuth = document.getElementById('btn-auth');
    if(btnAuth) btnAuth.disabled = true;
}

// ============================================
// FONCTIONS AUTH
// ============================================
async function connexion() {
    const email = document.getElementById('email-connexion').value.trim();
    const password = document.getElementById('password-connexion').value.trim();
    
    if(!email || !password) { afficherErreurAuth('Email et mot de passe requis'); return; }
    if(!turnstileConnexionToken) { afficherErreurAuth('Veuillez valider le captcha'); return; }
    
    try {
        await auth.signInWithEmailAndPassword(email, password);
        hideAuthModal();
        resetTurnstileWidgets();
    } catch(error) { 
        afficherErreurAuth(error.message);
        if(typeof turnstile !== 'undefined') {
            const connWidget = document.querySelector('#turnstile-connexion-container .cf-turnstile');
            if(connWidget) turnstile.reset(connWidget);
        }
        turnstileConnexionToken = null;
        const btnAuth = document.getElementById('btn-auth');
        if(btnAuth) btnAuth.disabled = true;
    }
}

async function inscription() {
    const nom = document.getElementById('nom-inscription').value.trim();
    const email = document.getElementById('email-inscription').value.trim();
    const password = document.getElementById('password-inscription').value.trim();
    const parrainId = document.getElementById('parrain-id')?.value.trim() || '';
    
    if(!nom || !email || !password) { afficherErreurAuth('Tous les champs sont requis'); return; }
    if(password.length < 6) { afficherErreurAuth('Mot de passe trop court (6 caractères minimum)'); return; }
    if(!turnstileInscriptionToken) { afficherErreurAuth('Veuillez valider le captcha'); return; }
    
    try {
        const uc = await auth.createUserWithEmailAndPassword(email, password);
        await uc.user.updateProfile({displayName: nom});
        
        let parrainValide = false;
        if(parrainId) {
            const usersSnap = await database.ref('donnees/utilisateurs').once('value');
            const users = usersSnap.val() || {};
            for(const [uid, userData] of Object.entries(users)) {
                if(userData.id === parrainId || uid === parrainId) {
                    parrainValide = true;
                    await database.ref(`donnees/utilisateurs/${uc.user.uid}`).update({ parrainId: uid });
                    break;
                }
            }
        }
        
        hideAuthModal();
        resetTurnstileWidgets();
        alert('Inscription réussie ! ' + (parrainValide ? 'Code parrain enregistré.' : '') + '\n\nAjoutez vos numéros dans votre profil pour commencer à échanger.');
    } catch(error) { 
        afficherErreurAuth(error.message);
        if(typeof turnstile !== 'undefined') {
            const inscWidget = document.querySelector('#inscription-form .cf-turnstile');
            if(inscWidget) turnstile.reset(inscWidget);
        }
        turnstileInscriptionToken = null;
        const btnAuth = document.getElementById('btn-auth');
        if(btnAuth) btnAuth.disabled = true;
    }
}

function authentifier() { 
    if(modeAuth === 'connexion') connexion(); 
    else inscription(); 
}

function switchAuthMode(m) {
    modeAuth = m;
    const connexionForm = document.getElementById('connexion-form');
    const inscriptionForm = document.getElementById('inscription-form');
    const turnstileConnexionContainer = document.getElementById('turnstile-connexion-container');
    const btnConnexion = document.getElementById('btn-connexion-mode');
    const btnInscription = document.getElementById('btn-inscription-mode');
    const btnAuth = document.getElementById('btn-auth');
    
    if(m === 'connexion') {
        connexionForm.style.display = 'block';
        inscriptionForm.style.display = 'none';
        turnstileConnexionContainer.style.display = 'block';
        btnConnexion.className = 'btn btn-success';
        btnInscription.className = 'btn';
        btnAuth.innerHTML = '<i class="fas fa-check"></i> Se connecter';
        btnAuth.disabled = true;
        resetTurnstileWidgets();
    } else {
        connexionForm.style.display = 'none';
        inscriptionForm.style.display = 'block';
        turnstileConnexionContainer.style.display = 'none';
        btnConnexion.className = 'btn';
        btnInscription.className = 'btn btn-success';
        btnAuth.innerHTML = '<i class="fas fa-user-plus"></i> S\'inscrire';
        btnAuth.disabled = true;
        resetTurnstileWidgets();
    }
}

function afficherErreurAuth(message) {
    document.getElementById('erreur-texte').textContent = message;
    document.getElementById('erreur-auth').classList.add('show');
}

function resetTurnstileWidgets() {
    turnstileInscriptionToken = null;
    turnstileConnexionToken = null;
    
    const statusInscription = document.getElementById('turnstile-inscription-status');
    if(statusInscription) statusInscription.innerHTML = '';
    const statusConnexion = document.getElementById('turnstile-connexion-status');
    if(statusConnexion) statusConnexion.innerHTML = '';
    
    if(typeof turnstile !== 'undefined') {
        const inscWidget = document.querySelector('#inscription-form .cf-turnstile');
        if(inscWidget && inscWidget.querySelector('iframe')) turnstile.reset(inscWidget);
        const connWidget = document.querySelector('#turnstile-connexion-container .cf-turnstile');
        if(connWidget && connWidget.querySelector('iframe')) turnstile.reset(connWidget);
    }
    
    const btnAuth = document.getElementById('btn-auth');
    if(btnAuth) btnAuth.disabled = true;
}

function deconnexion() {
    if(confirm('Êtes-vous sûr de vouloir vous déconnecter ?')){
        auth.signOut().then(() => {
            utilisateurCourant = null;
            sessionValide = false;
            monUid = null;
            adressesUtilisateur = {};
            toursGratuits = 0;
            filleulsCount = 0;
            showLandingPage();
            mettreAJourAffichage();
        });
    }
}

// ============================================
// ÉCOUTEUR AUTH (UNIQUE SOURCE DE VÉRITÉ)
// ============================================
auth.onAuthStateChanged(async (fbUser) => {
    if(fbUser) {
        monUid = fbUser.uid;
        const userRef = database.ref(`donnees/utilisateurs/${monUid}`);
        const snapshot = await userRef.once('value');
        if(snapshot.exists()) {
            utilisateurCourant = snapshot.val();
            utilisateurCourant.uid = monUid;
            adressesUtilisateur = utilisateurCourant.adressesLiees || {};
            toursGratuits = utilisateurCourant.toursGratuits || 0;
            filleulsCount = utilisateurCourant.filleulsCount || 0;
        } else {
            const urlParams = new URLSearchParams(window.location.search);
            const refId = urlParams.get('ref');
            const nouvelUtilisateur = {
                id: genererIDStable(fbUser.email, fbUser.displayName || 'Utilisateur'),
                nom: fbUser.displayName || fbUser.email.split('@')[0],
                email: fbUser.email,
                dateInscription: new Date().toISOString(),
                numeros: {},
                adressesLiees: {},
                codePIN: { hash: null, salt: null, actif: false, tentativeEchouees: 0, bloque: false },
                toursGratuits: 0,
                filleulsCount: 0,
                parrainId: refId || '',
                bonusParrainageDonne: false
            };
            await userRef.set(nouvelUtilisateur);
            utilisateurCourant = nouvelUtilisateur;
            utilisateurCourant.uid = monUid;
            adressesUtilisateur = {};
            toursGratuits = 0;
            filleulsCount = 0;
            if(refId) setTimeout(() => verifierParrainageEtAjouterTour(monUid), 5000);
        }
        sessionValide = true;
        mettreAJourAffichage();
        demarrerEcouteNumeros();
        demarrerEcouteAdresses();
        verifierAccesBonus();
        mettreAJourAffichageAffiliation();
        rafraichirDemandesOptimise();
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
        mettreAJourAffichage();
    }
});