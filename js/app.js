// ============================================
// INITIALISATION DE L'APPLICATION
// ============================================

// Initialisation au chargement
window.addEventListener('load', function() {
    console.log('🚀 TYPH X-CHAIN démarré - Version sécurisée');
    chargerDonnees();
    
    // Double-clic sur logo pour admin (optionnel)
    const logo = document.querySelector('.logo');
    if(logo) {
        logo.addEventListener('dblclick', () => {
            if(utilisateurCourant && utilisateurCourant.admin === true) {
                window.open('admin.html', '_blank');
            } else if(utilisateurCourant) {
                alert('⚠️ Accès réservé aux administrateurs');
            }
        });
    }
});