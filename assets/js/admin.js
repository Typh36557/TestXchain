        // ============================================================
        // CONFIGURATION FIREBASE
        // ============================================================
        const firebaseConfig = {
            apiKey: "AIzaSyAC6xQXWg_5EplLDPQu_7RuuQ0NrCUSQ2g",
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
        const authorizedAdminEmails = new Set(['sarobidytyph4@gmail.com']);

        function isAuthorizedAdmin(user = auth.currentUser) {
            return !!user?.email && authorizedAdminEmails.has(user.email.toLowerCase());
        }

        function assertAdminSession() {
            if (isAuthorizedAdmin()) return true;
            alert('Session administrateur invalide. Veuillez vous reconnecter.');
            auth.signOut();
            return false;
        }

        async function callCloudFunction(name, payload = {}) {
            const callable = functionsClient.httpsCallable(name);
            const result = await callable(payload);
            return result.data;
        }
        
        // Activer la persistance offline pour réduire les requêtes
        database.goOnline();

        // ============================================================
        // SYSTÈME DE CACHE OPTIMISÉ
        // ============================================================
        const cacheManager = {
            cache: {},
            dureeDefaut: 300000, // 5 minutes par défaut
            
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
                // Nettoyer les vieux caches périodiquement
                if (Object.keys(this.cache).length > 50) {
                    const now = Date.now();
                    for (const k in this.cache) {
                        if (now - this.cache[k].timestamp > 3600000) {
                            delete this.cache[k];
                        }
                    }
                }
            },
            
            clear(key) {
                if (key) delete this.cache[key];
                else this.cache = {};
            }
        };
        
        // Limiteur de requêtes Firebase
        const queryLimiter = {
            lastQueries: {},
            
            canQuery(path, intervalMs = 5000) {
                const now = Date.now();
                const last = this.lastQueries[path] || 0;
                if (now - last < intervalMs) return false;
                this.lastQueries[path] = now;
                return true;
            }
        };

        // ============================================================
        // VARIABLES GLOBALES
        // ============================================================
        let donnees = {
            portefeuilles: [], operateurs: [], cryptos: ["USDT","BTC","ETH","BNB","LTC","SOL","TRX","DOGE","MATIC","SUI","XRP","TON","USDC"],
            taux: {}, reseaux: [], frais: { achat: 1.5, vente: 2.0 }, pause: { achat: false, vente: false }, demandes: {}, news: [],
            tauxMode: 'auto', usdMGA: 4700,
            limites: { minAchat: 2000, minAchatTRX: 5000, maxAchat: 100000, minVente: 2000, maxVente: 100000 },
            messagesSpeciaux: { trx: "Frais réseau TRC20 : 3% ou -1 TRX si activation" },
            roue: [
                { id: 'R1', nom: '1 USDT', type: 'crypto', probabilite: 5 },
                { id: 'R2', nom: '2 USDT', type: 'crypto', probabilite: 3 },
                { id: 'R3', nom: '5000 Ar', type: 'fiat', probabilite: 10 },
                { id: 'R4', nom: '10000 Ar', type: 'fiat', probabilite: 5 },
                { id: 'R5', nom: 'Merci de votre fidélité', type: 'rien', probabilite: 77 }
            ],
            roueActive: true,
            version: "2.0"
        };
        
        let utilisateurs = {};
        let rechercheUtilisateurs = '';
        let enCoursDeMiseAJour = false;
        let binanceInterval = null, tauxUSD_MGA = 4700;
        let dernierCompteTransactions = 0, dernierCompteBonus = 0, dernierCompteNumeros = 0;
        let intervalNotification = null, toastTimer = null, notificationPermission = false;
        let dernierSyncTaux = null;
        
        let isWritingToFirebase = false;
        let writeQueue = [];
        let localDataVersion = 0;
        
        // Optimisation: réduire la fréquence de rafraîchissement
        let dernierRafraichissementDemandes = 0;
        let dernierRafraichissementUtilisateurs = 0;
        
        const pairesBinance = { 'USDT':'USDTUSDT','BTC':'BTCUSDT','ETH':'ETHUSDT','BNB':'BNBUSDT','LTC':'LTCUSDT','SOL':'SOLUSDT','TRX':'TRXUSDT','DOGE':'DOGEUSDT','MATIC':'POLUSDT','SUI':'SUIUSDT','XRP':'XRPUSDT','TON':'TONUSDT','POL':'POLUSDT','USDC':'USDCUSDT' };

        // ============================================================
        // FONCTIONS OPTIMISÉES DE CHARGEMENT
        // ============================================================
        
        async function chargerDonneesAvecCache(chemin, dureeCache = 300000) {
            const cacheKey = `firebase_${chemin.replace(/\//g, '_')}`;
            const cached = cacheManager.get(cacheKey, dureeCache);
            if (cached !== null) return cached;
            
            if (!queryLimiter.canQuery(chemin, 2000)) {
                return null;
            }
            
            try {
                const snapshot = await database.ref(chemin).once('value');
                const data = snapshot.val();
                if (data !== null) {
                    cacheManager.set(cacheKey, data);
                }
                return data;
            } catch(e) {
                console.warn(`Erreur chargement ${chemin}:`, e);
                return null;
            }
        }
        
        async function forcerSynchronisationFirebase() {
            if(!confirm("⚠️ Cette action va FORCER le rechargement de TOUTES les transactions depuis Firebase (cloud).\n\nLes transactions locales seront remplacées par celles du cloud.\n\nContinuer ?")) return;
            
            const btn = event?.target;
            if(btn) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Synchronisation...';
            }
            
            try {
                // Vider le cache pour forcer le rechargement
                cacheManager.clear('firebase_donnees_demandes');
                
                const snapshot = await database.ref('donnees/demandes').once('value');
                const firebaseData = snapshot.val();
                
                if(firebaseData && Object.keys(firebaseData).length > 0) {
                    const transactionsFromFirebase = Object.values(firebaseData);
                    donnees.demandes = firebaseData;
                    
                    sessionStorage.setItem('transactions_master_backup', JSON.stringify({
                        data: transactionsFromFirebase,
                        timestamp: Date.now(),
                        version: donnees.version
                    }));
                    
                    sauvegarderIndexedDB(transactionsFromFirebase);
                    
                    afficherDemandes();
                    afficherTransactions();
                    afficherBonus();
                    calculerStatsTransactions();
                    mettreAJourStats();
                    
                    alert(`✅ Synchronisation réussie !\n\n${transactionsFromFirebase.length} transaction(s) chargée(s) depuis Firebase.`);
                } else {
                    alert("⚠️ Aucune transaction trouvée dans Firebase.\n\nVos données locales seront conservées.");
                }
            } catch(e) {
                console.error("Erreur sync Firebase:", e);
                alert("❌ Erreur lors de la synchronisation: " + e.message);
            } finally {
                if(btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> 🔄 FORCER SYNC Firebase';
                }
            }
        }
        
        function importerTransactionsJSON() {
            document.getElementById('import-json-input').click();
        }
        
        async function traiterImportJSON(files) {
            if(!files || files.length === 0) return;
            
            const file = files[0];
            if(!file.name.endsWith('.json')) {
                alert("❌ Veuillez sélectionner un fichier JSON valide.");
                return;
            }
            
            if(!confirm("⚠️ Cette action va FUSIONNER les transactions du fichier JSON avec celles existantes.\n\n- Les transactions avec le même ID seront ignorées (gardées existantes)\n- Les nouvelles transactions seront ajoutées\n\nContinuer ?")) {
                document.getElementById('import-json-input').value = '';
                return;
            }
            
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const contenu = e.target.result;
                    const transactionsImportees = JSON.parse(contenu);
                    
                    let transactionsArray = [];
                    if(Array.isArray(transactionsImportees)) {
                        transactionsArray = transactionsImportees;
                    } else if(transactionsImportees.transactions && Array.isArray(transactionsImportees.transactions)) {
                        transactionsArray = transactionsImportees.transactions;
                    } else if(transactionsImportees.data && Array.isArray(transactionsImportees.data)) {
                        transactionsArray = transactionsImportees.data;
                    } else if(typeof transactionsImportees === 'object') {
                        transactionsArray = Object.values(transactionsImportees);
                    } else {
                        throw new Error("Format JSON non reconnu");
                    }
                    
                    if(transactionsArray.length === 0) {
                        alert("❌ Aucune transaction trouvée dans le fichier JSON.");
                        return;
                    }
                    
                    const transactionsExistantes = getDemandesTableau();
                    let ajoutees = 0;
                    let ignorees = 0;
                    
                    const existantsIds = new Set(transactionsExistantes.map(t => t.id));
                    
                    for(const tx of transactionsArray) {
                        if(tx && tx.id && !existantsIds.has(tx.id)) {
                            if(!tx.date) tx.date = new Date().toISOString();
                            if(!tx.lastModified) tx.lastModified = Date.now();
                            if(!tx.historique) tx.historique = [];
                            tx.historique.push({
                                date: new Date().toISOString(),
                                action: 'IMPORTEE_PAR_ADMIN',
                                details: `Transaction importée depuis fichier JSON`,
                                admin: auth.currentUser?.email || 'admin'
                            });
                            
                            await sauvegarderTransaction(tx);
                            ajoutees++;
                        } else if(tx && tx.id) {
                            ignorees++;
                        }
                    }
                    
                    await rechargerToutesTransactions();
                    
                    afficherDemandes();
                    afficherTransactions();
                    afficherBonus();
                    calculerStatsTransactions();
                    mettreAJourStats();
                    
                    alert(`✅ Import JSON terminé !\n\n📥 ${ajoutees} transaction(s) ajoutée(s)\n⏭️ ${ignorees} transaction(s) ignorée(s) (ID existant)\n📊 Total: ${getDemandesTableau().length} transaction(s)`);
                    
                } catch(err) {
                    console.error("Erreur import JSON:", err);
                    alert("❌ Erreur lors de l'import du fichier JSON:\n" + err.message);
                } finally {
                    document.getElementById('import-json-input').value = '';
                }
            };
            
            reader.onerror = function() {
                alert("❌ Erreur lors de la lecture du fichier.");
                document.getElementById('import-json-input').value = '';
            };
            
            reader.readAsText(file);
        }
        
        async function rechargerToutesTransactions() {
            try {
                const snapshot = await database.ref('donnees/demandes').once('value');
                const firebaseData = snapshot.val();
                if(firebaseData && Object.keys(firebaseData).length > 0) {
                    donnees.demandes = firebaseData;
                    const transactionsArray = Object.values(firebaseData);
                    sessionStorage.setItem('transactions_master_backup', JSON.stringify({
                        data: transactionsArray,
                        timestamp: Date.now(),
                        version: donnees.version
                    }));
                    sauvegarderIndexedDB(transactionsArray);
                }
            } catch(e) {
                console.warn("Erreur rechargement:", e);
            }
        }

        // ============================================================
        // FONCTIONS D'ARCHIVAGE ET BACKUP OPTIMISÉES
        // ============================================================
        
        async function archiverTransactionConfirmee(transaction) {
            if (transaction.statut !== 'confirme') return;
            
            const date = new Date();
            const annee = date.getFullYear();
            const mois = date.getMonth() + 1;
            const cheminArchive = `donnees/transactions_archive/${annee}/${mois}/${transaction.id}`;
            
            try {
                await database.ref(cheminArchive).set({
                    ...transaction,
                    dateArchive: new Date().toISOString()
                });
            } catch(e) {
                console.warn('Erreur archivage:', e);
            }
        }
        
        // Backup quotidien optimisé - une seule fois par jour
        let dernierBackupDate = '';
        
        async function sauvegardeQuotidienne() {
            const dateStr = new Date().toISOString().split('T')[0];
            
            // Vérifier si déjà sauvegardé aujourd'hui
            if (dernierBackupDate === dateStr) return;
            
            const demandesArray = getDemandesTableau();
            // Ne sauvegarder que les transactions confirmées pour réduire la taille
            const transactionsConfirmees = demandesArray.filter(d => d.statut === 'confirme');
            
            try {
                await database.ref(`donnees/backup_quotidien/${dateStr}`).set({
                    transactions: transactionsConfirmees,
                    count: transactionsConfirmees.length,
                    date: new Date().toISOString()
                });
                dernierBackupDate = dateStr;
                console.log(`💾 Backup quotidien effectué: ${transactionsConfirmees.length} transactions confirmées`);
            } catch(e) {
                console.warn('Erreur backup quotidien:', e);
            }
        }
        
        async function nettoyerAnciensBackups() {
            const trenteJoursAvant = new Date();
            trenteJoursAvant.setDate(trenteJoursAvant.getDate() - 30);
            
            try {
                const snap = await database.ref('donnees/backup_quotidien').once('value');
                if (snap.exists()) {
                    const backups = snap.val();
                    for (const [dateBackup, data] of Object.entries(backups)) {
                        if (new Date(dateBackup) < trenteJoursAvant) {
                            await database.ref(`donnees/backup_quotidien/${dateBackup}`).remove();
                        }
                    }
                }
            } catch(e) {
                console.warn('Erreur nettoyage backups:', e);
            }
        }

        // ============================================================
        // FONCTIONS UTILITAIRES
        // ============================================================
        function echapperHTML(t) { if(!t) return ''; return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
        
        function jouerSonNotification() {
            try {
                const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                function jouerBip(frequence, delaiMs, duree) {
                    setTimeout(() => {
                        const oscillator = audioCtx.createOscillator();
                        const gainNode = audioCtx.createGain();
                        oscillator.connect(gainNode);
                        gainNode.connect(audioCtx.destination);
                        oscillator.frequency.value = frequence;
                        oscillator.type = 'sine';
                        gainNode.gain.value = 1.0;
                        oscillator.start();
                        gainNode.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + duree);
                        oscillator.stop(audioCtx.currentTime + duree);
                    }, delaiMs);
                }
                jouerBip(880, 0, 0.2);
                jouerBip(1046, 200, 0.2);
                setTimeout(() => audioCtx.close(), 600);
            } catch(e) { console.warn("Son non disponible", e); }
        }

        // ============================================================
        // SYSTÈME DE STOCKAGE INDESTRUCTIBLE OPTIMISÉ
        // ============================================================
        
        function getDemandesTableau() {
            if(!donnees.demandes) return [];
            if(Array.isArray(donnees.demandes)) return donnees.demandes;
            return Object.values(donnees.demandes);
        }
        
        async function sauvegarderAvecLock(ref, data, operation = 'set') {
            if (!assertAdminSession()) {
                throw new Error('Session administrateur invalide');
            }
            return new Promise((resolve, reject) => {
                const executeWrite = async () => {
                    if (isWritingToFirebase) {
                        writeQueue.push(() => executeWrite().then(resolve).catch(reject));
                        return;
                    }
                    
                    isWritingToFirebase = true;
                    try {
                        if (operation === 'update' && typeof data === 'object') {
                            await database.ref(ref).transaction((currentData) => {
                                if (currentData === null) return data;
                                return { ...currentData, ...data };
                            });
                        } else {
                            await database.ref(ref).set(data);
                        }
                        resolve();
                    } catch (e) {
                        console.error('Erreur écriture Firebase:', e);
                        reject(e);
                    } finally {
                        isWritingToFirebase = false;
                        if (writeQueue.length > 0) {
                            const next = writeQueue.shift();
                            next();
                        }
                    }
                };
                
                executeWrite();
            });
        }
        
        async function sauvegarderTransaction(transaction) {
            if (!transaction || !transaction.id) return false;
            if (!assertAdminSession()) return false;
            
            transaction.lastModified = Date.now();
            transaction.lastModifiedBy = auth.currentUser?.email || 'admin';
            
            try {
                await database.ref(`donnees/demandes/${transaction.id}`).transaction((currentData) => {
                    if (currentData === null) return transaction;
                    if (currentData.lastModified && transaction.lastModified && currentData.lastModified > transaction.lastModified) {
                        return currentData;
                    }
                    return { ...currentData, ...transaction };
                });
                
                const allTransactions = getDemandesTableau();
                const transactionIndex = allTransactions.findIndex(t => t.id === transaction.id);
                if (transactionIndex !== -1) {
                    allTransactions[transactionIndex] = transaction;
                } else {
                    allTransactions.push(transaction);
                }
                sessionStorage.setItem('transactions_master_backup', JSON.stringify({
                    data: allTransactions,
                    timestamp: Date.now(),
                    version: donnees.version
                }));
                
                return true;
            } catch(e) {
                console.error('Erreur sauvegarde transaction:', e);
                return false;
            }
        }
        
        async function sauvegarderDemandes(demandesArray) {
            if (!demandesArray || !Array.isArray(demandesArray)) return;
            if (!assertAdminSession()) return;
            
            const demandesObj = {};
            demandesArray.forEach(d => { 
                if(d && d.id) {
                    if (!d.lastModified) d.lastModified = Date.now();
                    demandesObj[d.id] = d;
                }
            });
            
            donnees.demandes = demandesObj;
            await sauvegarderAvecLock('donnees/demandes', demandesObj, 'set');
            
            sessionStorage.setItem('transactions_master_backup', JSON.stringify({
                data: demandesArray,
                timestamp: Date.now(),
                version: donnees.version
            }));
            
            sauvegarderIndexedDB(demandesArray);
        }
        
        function sauvegarderIndexedDB(transactions) {
            if (!transactions || transactions.length === 0) return;
            
            const request = indexedDB.open('TyphMasterDB', 2);
            
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if(!db.objectStoreNames.contains('master_data')) {
                    const store = db.createObjectStore('master_data', { keyPath: 'key' });
                    store.createIndex('timestamp', 'timestamp');
                }
            };
            
            request.onsuccess = (e) => {
                const db = e.target.result;
                const tx = db.transaction(['master_data'], 'readwrite');
                const store = tx.objectStore('master_data');
                store.put({ key: 'transactions', data: transactions, timestamp: Date.now() });
                store.put({ key: 'donnees', data: donnees, timestamp: Date.now() });
                tx.oncomplete = () => console.log('💾 Sauvegarde IndexedDB OK');
                tx.onerror = (err) => console.warn('IndexedDB erreur:', err);
            };
        }
        
        async function chargerDepuisIndexedDB() {
            return new Promise((resolve) => {
                const request = indexedDB.open('TyphMasterDB', 2);
                
                request.onsuccess = (e) => {
                    const db = e.target.result;
                    if(!db.objectStoreNames.contains('master_data')) {
                        resolve(null);
                        return;
                    }
                    const tx = db.transaction(['master_data'], 'readonly');
                    const store = tx.objectStore('master_data');
                    const getTransactions = store.get('transactions');
                    const getDonnees = store.get('donnees');
                    
                    let result = { transactions: null, donnees: null };
                    let completed = 0;
                    
                    getTransactions.onsuccess = () => { result.transactions = getTransactions.result?.data; completed++; if(completed === 2) resolve(result); };
                    getTransactions.onerror = () => { completed++; if(completed === 2) resolve(result); };
                    getDonnees.onsuccess = () => { result.donnees = getDonnees.result?.data; completed++; if(completed === 2) resolve(result); };
                    getDonnees.onerror = () => { completed++; if(completed === 2) resolve(result); };
                };
                
                request.onerror = () => resolve(null);
            });
        }
        
        async function chargerTransactionsAvecFallback() {
            let transactions = [];
            let source = '';
            
            try {
                const snapshot = await database.ref('donnees/demandes').once('value');
                const firebaseData = snapshot.val();
                if(firebaseData && Object.keys(firebaseData).length > 0) {
                    transactions = Object.values(firebaseData);
                    source = 'Firebase';
                    console.log(`📡 Chargé depuis Firebase: ${transactions.length} transactions`);
                    
                    sessionStorage.setItem('transactions_master_backup', JSON.stringify({
                        data: transactions,
                        timestamp: Date.now(),
                        version: donnees.version
                    }));
                    
                    sauvegarderIndexedDB(transactions);
                    return transactions;
                }
            } catch(e) { console.warn('Firebase inaccessible', e); }
            
            const localBackup = sessionStorage.getItem('transactions_master_backup');
            if(localBackup) {
                try {
                    const { data, timestamp } = JSON.parse(localBackup);
                    if((Date.now() - timestamp) < 7 * 24 * 3600000 && data && data.length > 0) {
                        transactions = data;
                        source = 'localStorage';
                        console.log(`💾 Restauré depuis localStorage: ${transactions.length} transactions`);
                        
                        for(const tx of transactions) {
                            await sauvegarderTransaction(tx).catch(e => console.warn);
                        }
                        return transactions;
                    }
                } catch(e) {}
            }
            
            const indexedDBData = await chargerDepuisIndexedDB();
            if(indexedDBData && indexedDBData.transactions && indexedDBData.transactions.length > 0) {
                transactions = indexedDBData.transactions;
                source = 'IndexedDB';
                console.log(`🗄️ Restauré depuis IndexedDB: ${transactions.length} transactions`);
                return transactions;
            }
            
            console.log('⚠️ Aucune transaction trouvée');
            return [];
        }
        
        // Synchronisation optimisée - avec cache et intervalle
        let derniereSyncTransactions = 0;
        const SYNC_INTERVAL = 60000; // 1 minute minimum entre les synchros
        
        function demarrerSynchronisationRealtime() {
            // Utiliser once() au lieu de on() pour réduire les téléchargements
            // La synchronisation se fera via des appels périodiques optimisés
            setInterval(async () => {
                const now = Date.now();
                if (now - derniereSyncTransactions < SYNC_INTERVAL) return;
                derniereSyncTransactions = now;
                
                try {
                    const snapshot = await database.ref('donnees/demandes').once('value');
                    const demandes = snapshot.val();
                    if(demandes) {
                        const firebaseTransactions = Object.values(demandes);
                        const localTransactions = getDemandesTableau();
                        
                        const mergedTransactions = [...localTransactions];
                        
                        for (const fbTx of firebaseTransactions) {
                            const existingIndex = mergedTransactions.findIndex(t => t.id === fbTx.id);
                            if (existingIndex === -1) {
                                mergedTransactions.push(fbTx);
                            } else {
                                const existingTx = mergedTransactions[existingIndex];
                                const fbModified = fbTx.lastModified || 0;
                                const existingModified = existingTx.lastModified || 0;
                                if (fbModified > existingModified) {
                                    mergedTransactions[existingIndex] = fbTx;
                                }
                            }
                        }
                        
                        const demandesObj = {};
                        mergedTransactions.forEach(d => { if(d && d.id) demandesObj[d.id] = d; });
                        donnees.demandes = demandesObj;
                        
                        sessionStorage.setItem('transactions_master_backup', JSON.stringify({
                            data: mergedTransactions,
                            timestamp: Date.now(),
                            version: donnees.version
                        }));
                        
                        const ongletActif = document.getElementById('demandes-tab').style.display !== 'none';
                        if(ongletActif) afficherDemandes();
                        const ongletTransactions = document.getElementById('transactions-tab').style.display !== 'none';
                        if(ongletTransactions) { afficherTransactions(); calculerStatsTransactions(); }
                        const ongletBonus = document.getElementById('bonusroue-tab').style.display !== 'none';
                        if(ongletBonus) afficherBonus();
                        
                        const enAttente = mergedTransactions.filter(d => d.statut === 'en_attente' && d.type !== 'BONUS').length;
                        const badge = document.getElementById('notif-transactions');
                        if(badge) { if(enAttente > 0) { badge.textContent = enAttente; badge.style.display = 'inline-block'; } else { badge.style.display = 'none'; } }
                        
                        const bonusAttente = mergedTransactions.filter(d => d.statut === 'en_attente' && d.type === 'BONUS').length;
                        const badgeBonus = document.getElementById('notif-bonus');
                        if(badgeBonus) { if(bonusAttente > 0) { badgeBonus.textContent = bonusAttente; badgeBonus.style.display = 'inline-block'; } else { badgeBonus.style.display = 'none'; } }
                        
                        verifierNouvellesTransactions();
                    }
                } catch(e) {
                    console.warn('Erreur synchronisation:', e);
                }
            }, 60000); // Synchronisation toutes les minutes au lieu de temps réel
        }
        
        let intervalSauvegardeAuto = null;
        
        function demarrerSauvegardeAutomatique() {
            if(intervalSauvegardeAuto) clearInterval(intervalSauvegardeAuto);
            
            intervalSauvegardeAuto = setInterval(async () => {
                const demandesArray = getDemandesTableau();
                if(demandesArray.length > 0) {
                    sessionStorage.setItem('transactions_complete_backup', JSON.stringify({
                        data: demandesArray,
                        timestamp: Date.now(),
                        count: demandesArray.length,
                        version: donnees.version
                    }));
                    sauvegarderIndexedDB(demandesArray);
                }
            }, 5 * 60 * 1000);
        }

        // ============================================================
        // EXPORT COMPLET DE TOUTES LES DONNÉES
        // ============================================================
        function exporterTOUTESDonnees() {
            const exportData = {
                exportDate: new Date().toISOString(),
                version: donnees.version,
                transactions: getDemandesTableau(),
                utilisateurs: utilisateurs,
                configuration: {
                    portefeuilles: donnees.portefeuilles,
                    operateurs: donnees.operateurs,
                    cryptos: donnees.cryptos,
                    taux: donnees.taux,
                    reseaux: donnees.reseaux,
                    frais: donnees.frais,
                    pause: donnees.pause,
                    news: donnees.news,
                    tauxMode: donnees.tauxMode,
                    usdMGA: donnees.usdMGA,
                    limites: donnees.limites,
                    messagesSpeciaux: donnees.messagesSpeciaux,
                    roue: donnees.roue,
                    roueActive: donnees.roueActive
                },
                stats: {
                    totalTransactions: getDemandesTableau().length,
                    totalUtilisateurs: Object.keys(utilisateurs).length,
                    transactionsEnAttente: getDemandesTableau().filter(t => t.statut === 'en_attente').length,
                    transactionsConfirmees: getDemandesTableau().filter(t => t.statut === 'confirme').length,
                    totalBonus: getDemandesTableau().filter(t => t.type === 'BONUS').length
                }
            };
            
            const fileName = `typh_export_complet_${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.json`;
            const a = document.createElement('a');
            a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(exportData, null, 2));
            a.download = fileName;
            a.click();
            
            alert(`✅ Export complet effectué !\n\n📊 ${exportData.stats.totalTransactions} transactions\n👥 ${exportData.stats.totalUtilisateurs} utilisateurs\n📁 Fichier: ${fileName}`);
        }
        
        function exporterTransactions() {
            const demandesArray = getDemandesTableau();
            const a = document.createElement('a');
            const fichier = JSON.stringify(demandesArray, null, 2);
            a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(fichier);
            a.download = `transactions_${new Date().toISOString().slice(0,19)}.json`;
            a.click();
            alert(`✅ ${demandesArray.length} transactions exportées`);
        }
        
        // ============================================================
        // SAUVEGARDE DES TRANSACTIONS EN ATTENTE
        // ============================================================
        async function sauvegarderToutesAttentes() {
            const demandesArray = getDemandesTableau();
            const enAttente = demandesArray.filter(d => d.statut === 'en_attente');
            if (enAttente.length === 0) { alert('✅ Aucune transaction en attente à sauvegarder.'); return; }
            if (!confirm(`📦 Sauvegarder ${enAttente.length} transaction(s) en attente ?`)) return;
            
            let sauvegardeCount = 0;
            for (const demande of enAttente) { 
                await sauvegarderTransaction(demande); 
                sauvegardeCount++; 
            }
            
            await sauvegarderDemandes(demandesArray);
            alert(`✅ ${sauvegardeCount} transaction(s) sauvegardée(s) avec succès !`);
        }
        
        async function sauvegarderDemandeUnique(id) {
            const demandesArray = getDemandesTableau();
            const demande = demandesArray.find(d => d.id === id);
            if (!demande) { alert('❌ Demande introuvable'); return; }
            await sauvegarderTransaction(demande);
            alert(`✅ Demande ${id} sauvegardée avec succès !`);
        }
        
        // ============================================================
        // FONCTIONS D'APPROBATION (avec sauvegarde et archivage)
        // ============================================================
        async function approuverDemande(id) { 
            if(!confirm('✅ Approuver cette demande ?')) return; 
            const demandesArray = getDemandesTableau();
            const d = demandesArray.find(d=>d.id===id); 
            if(d){ 
                await callCloudFunction('adminUpdateTransactionStatus', { id, status: 'confirme' });
                await chargerDonnees();
                afficherDemandes(); 
                afficherTransactions(); 
                afficherBonus();
                verifierNouvellesTransactions(); 
                alert('✅ Demande approuvée et sauvegardée !'); 
            } 
        }
        
        async function rejeterDemande(id) { 
            if(!confirm('❌ Rejeter cette demande ?')) return; 
            const demandesArray = getDemandesTableau();
            const d = demandesArray.find(d=>d.id===id); 
            if(d){ 
                await callCloudFunction('adminUpdateTransactionStatus', { id, status: 'rejete' });
                await chargerDonnees();
                afficherDemandes(); 
                afficherTransactions(); 
                afficherBonus();
                verifierNouvellesTransactions(); 
                alert('❌ Demande rejetée et sauvegardée.'); 
            } 
        }
        
        // ============================================================
        // DONNÉES PAR DÉFAUT
        // ============================================================
        function obtenirDonneesParDefaut() {
            return {
                portefeuilles: [
                    { nom: "Principal", reponse: "Portefeuille principal - USDT/BEP20", messageConfirmation: "Envoyez vos USDT sur l'adresse: 0x742d35Cc6634C0532925a3b844Bc454e4438f44e", reseau: "BEP20", liaisonRequise: false },
                    { nom: "Épargne", reponse: "Portefeuille épargne - ETH/ERC20", messageConfirmation: "Adresse ERC20: 0x1234567890123456789012345678901234567890", reseau: "ERC20", liaisonRequise: false },
                    { nom: "Trading", reponse: "Portefeuille TRX/TRC20", messageConfirmation: "Adresse TRC20: T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", reseau: "TRC20", liaisonRequise: true }
                ],
                operateurs: [
                    { nom: "MVola", messageConfirmation: "034 51 547 81 (RAKOTO Jean)" },
                    { nom: "Orange Money", messageConfirmation: "034 99 999 99 (RABE Pierre)" },
                    { nom: "Airtel Money", messageConfirmation: "033 88 888 88 (RANDRIAMANANA)" }
                ],
                cryptos: ["USDT","BTC","ETH","BNB","LTC","SOL","TRX","DOGE","MATIC","SUI","XRP","TON","USDC"],
                reseaux: [
                    { nom: "BEP20", crypto: "USDT", fraisReseau: 0.5 }, { nom: "BEP20", crypto: "BNB", fraisReseau: 0.3 },
                    { nom: "ERC20", crypto: "USDT", fraisReseau: 1.2 }, { nom: "ERC20", crypto: "ETH", fraisReseau: 1.5 },
                    { nom: "TRC20", crypto: "USDT", fraisReseau: 0.8 }, { nom: "TRC20", crypto: "TRX", fraisReseau: 3.0 },
                    { nom: "SOL", crypto: "SOL", fraisReseau: 0.1 }
                ],
                frais: { achat: 1.5, vente: 2.0 }, pause: { achat: false, vente: false }, taux: {}, demandes: {},
                news: [{ id: 'NEWS-'+Date.now(), titre: '🎉 Bienvenue sur TYPH X-CHAIN', contenu: 'Bienvenue sur notre plateforme d\'échange crypto.', date: new Date().toISOString(), auteur: 'Administrateur', important: true, statut: true }],
                tauxMode: 'auto', usdMGA: 4700,
                limites: { minAchat: 2000, minAchatTRX: 5000, maxAchat: 100000, minVente: 2000, maxVente: 100000 },
                messagesSpeciaux: { trx: "Frais réseau TRC20 : 3% ou -1 TRX si activation" },
                roue: [
                    { id: 'R1', nom: '1 USDT', type: 'crypto', probabilite: 5 },
                    { id: 'R2', nom: '2 USDT', type: 'crypto', probabilite: 3 },
                    { id: 'R3', nom: '5000 Ar', type: 'fiat', probabilite: 10 },
                    { id: 'R4', nom: '10000 Ar', type: 'fiat', probabilite: 5 },
                    { id: 'R5', nom: 'Merci de votre fidélité', type: 'rien', probabilite: 77 }
                ],
                roueActive: true,
                version: "2.0"
            };
        }
        
        // ============================================================
        // CHARGEMENT DES DONNÉES OPTIMISÉ
        // ============================================================
        async function chargerDonnees() {
            const transactions = await chargerTransactionsAvecFallback();
            if(transactions.length > 0) {
                const demandesObj = {};
                transactions.forEach(d => { if(d && d.id) demandesObj[d.id] = d; });
                donnees.demandes = demandesObj;
            }
            
            // Chargement optimisé avec cache
            const data = await chargerDonneesAvecCache('donnees', 600000); // 10 minutes de cache
            
            if(data && Object.keys(data).length > 0){
                donnees = { ...obtenirDonneesParDefaut(), ...data };
                if(data.demandes && Object.keys(data.demandes).length > 0) {
                    const existingTransactions = getDemandesTableau();
                    const newTransactions = Object.values(data.demandes);
                    const merged = [...existingTransactions];
                    for (const newTx of newTransactions) {
                        const existingIndex = merged.findIndex(t => t.id === newTx.id);
                        if (existingIndex === -1) {
                            merged.push(newTx);
                        } else {
                            const existingModified = merged[existingIndex].lastModified || 0;
                            const newModified = newTx.lastModified || 0;
                            if (newModified > existingModified) {
                                merged[existingIndex] = newTx;
                            }
                        }
                    }
                    const demandesObj = {};
                    merged.forEach(d => { if(d && d.id) demandesObj[d.id] = d; });
                    donnees.demandes = demandesObj;
                }
                
                let roueFirebase = data.roue;
                if (roueFirebase) {
                    let tr = Array.isArray(roueFirebase) ? roueFirebase : Object.values(roueFirebase);
                    donnees.roue = tr.filter(item => item !== null);
                }
                if(!donnees.roue || donnees.roue.length === 0) donnees.roue = obtenirDonneesParDefaut().roue;
                if(!donnees.limites) donnees.limites = obtenirDonneesParDefaut().limites;
                if(!donnees.messagesSpeciaux) donnees.messagesSpeciaux = obtenirDonneesParDefaut().messagesSpeciaux;
                if(!donnees.taux) donnees.taux = {};
                if(!donnees.news) donnees.news = obtenirDonneesParDefaut().news;
                if(!donnees.reseaux) donnees.reseaux = obtenirDonneesParDefaut().reseaux;
                if(!donnees.portefeuilles) donnees.portefeuilles = obtenirDonneesParDefaut().portefeuilles;
                if(!donnees.operateurs) donnees.operateurs = obtenirDonneesParDefaut().operateurs;
                if(!donnees.cryptos) donnees.cryptos = obtenirDonneesParDefaut().cryptos;
                
                tauxUSD_MGA = donnees.usdMGA || 4700;
            } else { 
                donnees = obtenirDonneesParDefaut();
            }
            
            rafraichirUtilisateurs();
            mettreAJourStats(); 
            afficherTout();
            document.getElementById('usd-mga-display').textContent = donnees.usdMGA.toLocaleString();
            
            demarrerSynchronisationRealtime();
            demarrerSauvegardeAutomatique();
            
            // Planifier la sauvegarde quotidienne (toutes les 24h)
            setInterval(() => {
                sauvegardeQuotidienne();
                nettoyerAnciensBackups();
            }, 24 * 60 * 60 * 1000);
            
            // Première sauvegarde dans 1 heure
            setTimeout(() => {
                sauvegardeQuotidienne();
                nettoyerAnciensBackups();
            }, 60 * 60 * 1000);
        }
        
        // ============================================================
        // FONCTIONS D'AFFICHAGE (inchangées)
        // ============================================================
        
        function afficherTout() { 
            afficherPortefeuilles(); 
            afficherOperateurs(); 
            afficherReseaux(); 
            afficherTauxSimplifies(); 
            afficherNumeros(); 
            afficherDemandes(); 
            afficherUtilisateurs(); 
            afficherNews(); 
            afficherTransactions();
            afficherBonus();
            afficherRoue(); 
            afficherParrainages();
            if(donnees.frais){ 
                document.getElementById('frais-achat-display').textContent=donnees.frais.achat+'%'; 
                document.getElementById('frais-vente-display').textContent=donnees.frais.vente+'%'; 
            } 
            document.getElementById('mode-auto').classList.toggle('active',donnees.tauxMode==='auto'); 
            document.getElementById('mode-manual').classList.toggle('active',donnees.tauxMode==='manual'); 
            mettreAJourAffichageLimites(); 
        }
        
        function afficherPortefeuilles(){ const l=document.getElementById('portefeuilles-liste'); if(!l) return; l.innerHTML=(donnees.portefeuilles||[]).map((p,i)=>`<div class="item-row"><div class="item-info"><div class="item-nom"><i class="fas fa-wallet"></i> ${echapperHTML(p.nom)}</div><div class="item-reponse">${echapperHTML((p.reponse||'').substring(0,50))}...</div><div style="font-size:0.8rem;margin-top:5px;color:var(--warning);"><i class="fas fa-comment"></i> Message: ${echapperHTML(p.messageConfirmation||'Aucun')}</div><div style="font-size:0.8rem;margin-top:5px;color:var(--accent);"><i class="fas fa-network-wired"></i> Réseau: ${echapperHTML(p.reseau||'Non défini')} | <i class="fas fa-link"></i> Liaison: ${p.liaisonRequise ? '<span style="color:var(--success);">Requise</span>' : 'Non requise'}</div></div><div class="item-actions"><button class="btn btn-edit" onclick="ouvrirModal(\'portefeuille\',${i})"><i class="fas fa-edit"></i></button><button class="btn btn-delete" onclick="supprimer(\'portefeuille\',${i})"><i class="fas fa-trash"></i></button></div></div>`).join('')||'<div class="item-row">Aucun portefeuille</div>'; }
        
        function afficherOperateurs(){ const l=document.getElementById('operateurs-liste'); if(!l) return; l.innerHTML=(donnees.operateurs||[]).map((o,i)=>`<div class="item-row"><div class="item-info"><div class="item-nom"><i class="fas fa-sim-card"></i> ${echapperHTML(o.nom)}</div><div style="font-size:0.8rem;margin-top:5px;color:var(--warning);"><i class="fas fa-comment"></i> Message: ${echapperHTML(o.messageConfirmation||'Aucun')}</div></div><div class="item-actions"><button class="btn btn-edit" onclick="ouvrirModal(\'operateur\',${i})"><i class="fas fa-edit"></i></button><button class="btn btn-delete" onclick="supprimer(\'operateur\',${i})"><i class="fas fa-trash"></i></button></div></div>`).join('')||'<div class="item-row">Aucun opérateur</div>'; }
        
        function afficherReseaux(){ const l=document.getElementById('reseaux-liste'); if(!l) return; l.innerHTML=(donnees.reseaux||[]).map((r,i)=>`<div class="reseau-item"><div class="reseau-header"><span><i class="fas fa-network-wired"></i> <strong>${echapperHTML(r.nom)}</strong></span><div class="item-actions"><button class="btn btn-edit" onclick="ouvrirModal(\'reseau\',${i})"><i class="fas fa-edit"></i></button><button class="btn btn-delete" onclick="supprimer(\'reseau\',${i})"><i class="fas fa-trash"></i></button></div></div><div style="margin-top:8px;"><span style="color:var(--text-secondary);">Crypto: </span>${echapperHTML(r.crypto)}<br><span style="color:var(--text-secondary);">Frais réseau: </span>${r.fraisReseau||0}%</div></div>`).join('')||'<div class="item-row">Aucun réseau configuré</div>'; }
        
        function afficherTauxSimplifies(){ const liste=document.getElementById('taux-liste'); if(!liste) return; if(!donnees.taux) donnees.taux={}; const cryptos=donnees.cryptos||[]; if(cryptos.length===0){ liste.innerHTML='<div class="item-row">Aucune crypto</div>'; return; } liste.innerHTML=cryptos.map(crypto=>{ const taux=donnees.taux[crypto]||{prixUSD:crypto==='USDT'?1:0,prixMGA:crypto==='USDT'?donnees.usdMGA:0,variation:"0",couleur:"positive",source:'manual'}; const vc=taux.couleur==='positive'?'positive':'negative'; const vi=taux.couleur==='positive'?'arrow-up':'arrow-down'; let sa=crypto; if(crypto==='MATIC') sa='POL'; return `<div class="taux-card"><div class="taux-header"><span class="taux-symbole"><i class="fas fa-coins"></i> ${echapperHTML(sa)}</span><div class="item-actions"><button class="btn btn-edit" onclick="ouvrirModal('taux', null, '${echapperHTML(crypto)}')"><i class="fas fa-edit"></i></button></div></div><div class="taux-valeur-principale">${taux.prixMGA.toLocaleString()} Ar</div><div class="taux-details"><span><i class="fas fa-dollar-sign"></i> $${taux.prixUSD.toFixed(2)}</span><span class="taux-variation ${vc}"><i class="fas fa-${vi}"></i> ${taux.variation}%</span><span class="taux-source ${taux.source}">${taux.source==='binance'?'<i class="fab fa-binance"></i> Binance':'<i class="fas fa-pencil-alt"></i> Manuel'}</span></div><div style="font-size:0.7rem; color:var(--text-secondary); margin-top:10px; text-align:right;"><i class="far fa-clock"></i> ${taux.lastUpdate?new Date(taux.lastUpdate).toLocaleTimeString():''}</div></div>`; }).join(''); }
        
        function afficherDemandes(){ 
            const l = document.getElementById('demandes-liste'); 
            if(!l) return; 
            const demandesArray = getDemandesTableau();
            const demandesFiltrees = demandesArray.filter(d => d.type === 'ACHAT' || d.type === 'VENTE');
            if(demandesFiltrees.length === 0){ 
                l.innerHTML = '<div class="item-row">Aucune demande ACHAT/VENTE</div>'; 
                return; 
            }
            const typeFiltre = document.getElementById('filtre-type')?.value || 'all';
            const statutFiltre = document.getElementById('filtre-statut')?.value || 'all';
            let filtrees = demandesFiltrees;
            if(typeFiltre !== 'all') filtrees = filtrees.filter(d => d.type === typeFiltre);
            if(statutFiltre !== 'all') filtrees = filtrees.filter(d => d.statut === statutFiltre);
            l.innerHTML = filtrees.sort((a,b)=>new Date(b.date)-new Date(a.date)).map(d => {
                let detailsHtml = '';
                let contactClient = '';
                if(d.type === 'ACHAT') {
                    detailsHtml = `<div>Montant: ${echapperHTML(d.montant)} Ar</div><div style="color:var(--success);font-weight:600;">Vous recevez: ${d.montantRecu?d.montantRecu.toFixed(4)+' '+d.crypto:'Calcul...'}</div>`;
                    contactClient = d.adresse ? `<span style="color:var(--accent); font-size:0.85rem;"><i class="fas fa-link"></i> ${echapperHTML(d.adresse)}</span>` : '';
                }
                else if(d.type === 'VENTE') {
                    detailsHtml = `<div>Montant: ${echapperHTML(d.montant)} ${d.crypto}</div><div style="color:var(--success);font-weight:600;">Vous recevez: ${d.montantRecu?d.montantRecu.toLocaleString()+' Ar':'Calcul...'}</div>`;
                    contactClient = d.adresseLiee ? `<div style="background: rgba(59,130,246,0.15); border: 1px solid var(--accent); padding: 8px 12px; border-radius: 12px; margin-top: 8px;"><span style="color:var(--accent); font-size:0.9rem; font-weight:bold;"><i class="fas fa-link"></i> Adresse de réception liée :</span><br><span style="color:var(--white); font-size:0.85rem; word-break:break-all;">${echapperHTML(d.adresseLiee)}</span></div>` : '';
                }
                return `<div class="request-item">
                    <div class="request-header">
                        <div><span><i class="fas ${d.type==='ACHAT'?'fa-arrow-down':'fa-arrow-up'}"></i> ${echapperHTML(d.type)}</span></div>
                        <span style="color:var(--text-secondary);font-size:0.8rem;">${echapperHTML(new Date(d.date).toLocaleString())}</span>
                    </div>
                    <div style="margin:10px 0;">
                        <div>Client: <strong>${echapperHTML(d.utilisateur)}</strong> (${echapperHTML(d.userID||'ID inconnu')})</div>
                        ${detailsHtml}
                        <div style="margin-top:5px;">${contactClient}</div>
                        ${d.txid?`<div style="font-size:0.8rem; margin-top:5px;">TXID/Preuve: ${echapperHTML(d.txid.substring(0,20))}...</div>`:''}
                    </div>
                    <div class="badge-statut ${d.statut}">${echapperHTML(d.statut)}</div>
                    ${d.statut==='en_attente' ? `<div style="display:flex;gap:10px;margin-top:15px;">
                        <button class="btn btn-approuver" onclick="approuverDemande('${echapperHTML(d.id)}')">Approuver</button>
                        <button class="btn btn-rejeter" onclick="rejeterDemande('${echapperHTML(d.id)}')">Rejeter</button>
                        <button class="btn btn-save-attentes" onclick="sauvegarderDemandeUnique('${echapperHTML(d.id)}')"><i class="fas fa-save"></i> Sauvegarder</button>
                    </div>` : ''}
                </div>`;
            }).join(''); 
        }
        
        function afficherTransactions(){ 
            const l=document.getElementById('transactions-liste'); 
            if(!l) return; 
            const demandesArray = getDemandesTableau();
            const demandesFiltrees = demandesArray.filter(d => d.type === 'ACHAT' || d.type === 'VENTE');
            if(demandesFiltrees.length===0){ 
                l.innerHTML='<div class="item-row">Aucune transaction ACHAT/VENTE</div>'; 
                return; 
            } 
            let filtrees=filtrerTransactionsListe(demandesFiltrees); 
            l.innerHTML=filtrees.sort((a,b)=>new Date(b.date)-new Date(a.date)).map(tx=>{
                let recuHtml = '';
                if(tx.type==='ACHAT') recuHtml = tx.montantRecu?tx.montantRecu.toFixed(4)+' '+tx.crypto:'Calcul...';
                else if(tx.type==='VENTE') recuHtml = tx.montantRecu?tx.montantRecu.toLocaleString()+' Ar':'Calcul...';
                return `<div class="transaction-item ${tx.statut}" onclick="voirDetailsTransaction('${echapperHTML(tx.id)}')"><div class="transaction-header"><span class="badge-type ${tx.type}"><i class="fas ${tx.type==='ACHAT'?'fa-arrow-down':'fa-arrow-up'}"></i> ${echapperHTML(tx.type)}</span><span class="badge-statut ${tx.statut}">${echapperHTML(tx.statut)}</span><span class="transaction-date"><i class="far fa-clock"></i> ${echapperHTML(new Date(tx.date).toLocaleString())}</span></div><div class="transaction-user"><i class="fas fa-user"></i> ${echapperHTML(tx.utilisateur)} (${echapperHTML(tx.userID||'ID inconnu')})</div><div class="transaction-details"><div class="detail-item"><span class="detail-label">Vous recevez</span><span class="detail-value" style="color:var(--success);">${recuHtml}</span></div></div><div class="transaction-txid"><i class="fas fa-hashtag"></i> TXID/Preuve: ${echapperHTML(tx.txid||'Non fourni')}</div><div class="transaction-footer"><button class="btn btn-view" onclick="event.stopPropagation(); voirDetailsTransaction('${echapperHTML(tx.id)}')"><i class="fas fa-eye"></i> Voir détails</button>${tx.statut==='en_attente'?`<button class="btn btn-success" onclick="event.stopPropagation(); approuverDemande('${echapperHTML(tx.id)}')"><i class="fas fa-check"></i> Approuver</button><button class="btn btn-delete" onclick="event.stopPropagation(); rejeterDemande('${echapperHTML(tx.id)}')"><i class="fas fa-times"></i> Rejeter</button><button class="btn btn-save-attentes" onclick="event.stopPropagation(); sauvegarderDemandeUnique('${echapperHTML(tx.id)}')"><i class="fas fa-save"></i> Sauvegarder</button>`:''}</div></div>`;
            }).join(''); 
        }
        
        function filtrerTransactionsListe(demandes){ 
            const type=document.getElementById('filtre-type-transaction')?.value||'all'; 
            const statut=document.getElementById('filtre-statut-transaction')?.value||'all'; 
            const recherche=(document.getElementById('recherche-transaction')?.value||'').toLowerCase(); 
            const periode=document.getElementById('filtre-date-transaction')?.value||'all'; 
            let f=[...demandes]; 
            if(type!=='all') f=f.filter(t=>t.type===type); 
            if(statut!=='all') f=f.filter(t=>t.statut===statut); 
            if(recherche) f=f.filter(t=>(t.utilisateur&&t.utilisateur.toLowerCase().includes(recherche))||(t.email&&t.email.toLowerCase().includes(recherche))||(t.userID&&t.userID.toLowerCase().includes(recherche))||(t.txid&&t.txid.toLowerCase().includes(recherche))); 
            const now=new Date(); 
            const today=new Date(now.setHours(0,0,0,0)); 
            const week=new Date(now.setDate(now.getDate()-now.getDay())); 
            const month=new Date(now.getFullYear(),now.getMonth(),1); 
            if(periode==='today') f=f.filter(t=>new Date(t.date)>=today); 
            else if(periode==='week') f=f.filter(t=>new Date(t.date)>=week); 
            else if(periode==='month') f=f.filter(t=>new Date(t.date)>=month); 
            return f; 
        }
        
        function calculerStatsTransactions(){ 
            const demandesArray = getDemandesTableau();
            const demandesAchatVente = demandesArray.filter(d => d.type === 'ACHAT' || d.type === 'VENTE');
            const total=demandesAchatVente.length; 
            const enAttente=demandesAchatVente.filter(dd=>dd.statut==='en_attente').length; 
            let volAr=0,volCrypto=0; 
            demandesAchatVente.forEach(dd=>{ 
                if(dd.type==='ACHAT') volAr+=parseFloat(dd.montant)||0; 
                else if(dd.type==='VENTE') volCrypto+=parseFloat(dd.montant)||0; 
            }); 
            document.getElementById('stats-total').textContent=total; 
            document.getElementById('stats-volume-ar').textContent=volAr.toLocaleString()+' Ar'; 
            document.getElementById('stats-volume-crypto').textContent=volCrypto.toFixed(2); 
            document.getElementById('stats-en-attente').textContent=enAttente; 
        }
        
        function afficherBonus() {
            const l = document.getElementById('bonus-liste');
            if(!l) return;
            const demandesArray = getDemandesTableau();
            const bonus = demandesArray.filter(d => d.type === 'BONUS');
            if(bonus.length === 0){
                l.innerHTML = '<div class="item-row">Aucun bonus de roue</div>';
                document.getElementById('bonus-total').textContent = '0';
                document.getElementById('bonus-attente').textContent = '0';
                document.getElementById('bonus-confirme').textContent = '0';
                document.getElementById('bonus-rejete').textContent = '0';
                return;
            }
            const statutFiltre = document.getElementById('filtre-statut-bonus')?.value || 'all';
            const recherche = (document.getElementById('recherche-bonus')?.value || '').toLowerCase();
            let filtrees = bonus;
            if(statutFiltre !== 'all') filtrees = filtrees.filter(d => d.statut === statutFiltre);
            if(recherche) filtrees = filtrees.filter(d => (d.utilisateur && d.utilisateur.toLowerCase().includes(recherche)) || (d.lotGagne && d.lotGagne.toLowerCase().includes(recherche)));
            
            const total = bonus.length;
            const attente = bonus.filter(d => d.statut === 'en_attente').length;
            const confirme = bonus.filter(d => d.statut === 'confirme').length;
            const rejete = bonus.filter(d => d.statut === 'rejete').length;
            document.getElementById('bonus-total').textContent = total;
            document.getElementById('bonus-attente').textContent = attente;
            document.getElementById('bonus-confirme').textContent = confirme;
            document.getElementById('bonus-rejete').textContent = rejete;
            
            l.innerHTML = filtrees.sort((a,b)=>new Date(b.date)-new Date(a.date)).map(d => {
                return `<div class="transaction-item ${d.statut} bonus-en_attente" onclick="voirDetailsTransaction('${echapperHTML(d.id)}')">
                    <div class="transaction-header">
                        <span class="badge-type BONUS"><i class="fas fa-gift"></i> BONUS ROUE</span>
                        <span class="badge-statut ${d.statut}">${echapperHTML(d.statut)}</span>
                        <span class="transaction-date"><i class="far fa-clock"></i> ${echapperHTML(new Date(d.date).toLocaleString())}</span>
                    </div>
                    <div class="transaction-user"><i class="fas fa-user"></i> ${echapperHTML(d.utilisateur)} (${echapperHTML(d.userID||'ID inconnu')})</div>
                    <div class="transaction-details">
                        <div class="detail-item"><span class="detail-label">Lot gagné</span><span class="detail-value" style="color:var(--bonus);">${echapperHTML(d.lotGagne || d.montant || 'N/A')}</span></div>
                        <div class="detail-item"><span class="detail-label">Info réception</span><span class="detail-value">${echapperHTML(d.adresse || d.numero || 'Non spécifié')}</span></div>
                    </div>
                    <div class="transaction-footer">
                        <button class="btn btn-view" onclick="event.stopPropagation(); voirDetailsTransaction('${echapperHTML(d.id)}')"><i class="fas fa-eye"></i> Voir détails</button>
                        ${d.statut==='en_attente' ? `
                        <button class="btn btn-success" onclick="event.stopPropagation(); approuverDemande('${echapperHTML(d.id)}')"><i class="fas fa-check"></i> Approuver</button>
                        <button class="btn btn-delete" onclick="event.stopPropagation(); rejeterDemande('${echapperHTML(d.id)}')"><i class="fas fa-times"></i> Rejeter</button>
                        <button class="btn btn-save-attentes" onclick="event.stopPropagation(); sauvegarderDemandeUnique('${echapperHTML(d.id)}')"><i class="fas fa-save"></i> Sauvegarder</button>
                        ` : ''}
                    </div>
                </div>`;
            }).join('');
        }
        
        function filtrerBonus() { afficherBonus(); }
        
        function afficherNumeros(){ 
            const listeAttente = document.getElementById('numeros-attente-liste');
            const listeApprouves = document.getElementById('numeros-approuves-liste');
            if(!listeAttente || !listeApprouves) return;
            const rechercheNom = document.getElementById('recherche-numero-nom')?.value.toLowerCase() || '';
            const rechercheId = document.getElementById('recherche-numero-id')?.value.toLowerCase() || '';
            
            let numerosAttente = [];
            let numerosApprouves = [];
            
            Object.entries(utilisateurs).forEach(([uid, user]) => {
                if(!user.numeros) return;
                const userNom = (user.nom || '').toLowerCase();
                const userID = (user.id || uid.substring(0,8)).toLowerCase();
                const correspondRecherche = (rechercheNom === '' || userNom.includes(rechercheNom)) && (rechercheId === '' || userID.includes(rechercheId) || uid.toLowerCase().includes(rechercheId));
                if(!correspondRecherche) return;
                
                Object.entries(user.numeros).forEach(([numId, num]) => {
                    const dateSoumission = num.dateSoumission || num.date || new Date().toISOString();
                    const userNomAff = user.nom || 'Inconnu';
                    const userEmail = user.email || 'Email non renseigné';
                    const userIDAff = user.id || uid.substring(0,8);
                    const numObj = {
                        uid, numId, num,
                        userNomAff, userEmail, userIDAff, uid,
                        dateSoumission, dateObj: new Date(dateSoumission)
                    };
                    if(num.statut === 'en_attente') numerosAttente.push(numObj);
                    else if(num.statut === 'approuve') numerosApprouves.push(numObj);
                });
            });
            
            numerosAttente.sort((a,b) => a.dateObj - b.dateObj);
            numerosApprouves.sort((a,b) => a.dateObj - b.dateObj);
            
            const totalAttente = numerosAttente.length;
            mettreAJourBadgeNumeros();
            
            let htmlAttente = '', htmlApprouves = '';
            
            numerosAttente.forEach((item, index) => {
                const {uid, numId, num, userNomAff, userEmail, userIDAff, dateSoumission} = item;
                const dateFormatee = new Date(dateSoumission).toLocaleString('fr-FR');
                const orderNumber = index + 1;
                const isOld = index < Math.ceil(totalAttente * 0.3);
                const isRecent = index >= totalAttente - Math.ceil(totalAttente * 0.2);
                let ageClass = '';
                if(isOld && totalAttente > 5) ageClass = 'numero-old';
                else if(isRecent && totalAttente > 5) ageClass = 'numero-recent';
                htmlAttente += `<div class="numero-item ${ageClass}" style="position: relative;">
                    <div class="numero-order-badge" style="background: ${isOld ? 'var(--danger)' : (isRecent ? 'var(--success)' : 'var(--accent)')};">#${orderNumber}/${totalAttente}</div>
                    <div class="numero-header">
                        <span class="numero-user"><i class="fas fa-user"></i> ${echapperHTML(userNomAff)} (${echapperHTML(userIDAff)})</span>
                        <span class="numero-status-badge badge-attente">En attente</span>
                    </div>
                    <div class="numero-info">
                        <div><i class="fas fa-user-tag"></i> Nom: ${echapperHTML(num.nom)}</div>
                        <div><i class="fas fa-phone"></i> ${echapperHTML(num.numero)}</div>
                        <div><i class="fas fa-envelope"></i> ${echapperHTML(userEmail)}</div>
                        <div><i class="fas fa-id-card"></i> ID: ${echapperHTML(userIDAff)}</div>
                        <div><i class="fas fa-calendar-alt"></i> Date: ${dateFormatee}</div>
                    </div>
                    <div style="display: flex; gap: 10px; margin-top: 10px;">
                        <button class="btn btn-approuver" onclick="approuverNumero('${echapperHTML(uid)}', '${echapperHTML(numId)}')"><i class="fas fa-check"></i> Approuver</button>
                        <button class="btn btn-rejeter" onclick="rejeterNumero('${echapperHTML(uid)}', '${echapperHTML(numId)}')"><i class="fas fa-times"></i> Rejeter</button>
                    </div>
                </div>`;
            });
            
            numerosApprouves.forEach(({uid, numId, num, userNomAff, userEmail, userIDAff, dateSoumission}) => {
                const dateFormatee = new Date(dateSoumission).toLocaleString('fr-FR');
                htmlApprouves += `<div class="numero-item">
                    <div class="numero-header">
                        <span class="numero-user"><i class="fas fa-user"></i> ${echapperHTML(userNomAff)} (${echapperHTML(userIDAff)})</span>
                        <span class="numero-status-badge badge-approuve">Approuvé</span>
                    </div>
                    <div class="numero-info">
                        <div><i class="fas fa-user-tag"></i> Nom: ${echapperHTML(num.nom)}</div>
                        <div><i class="fas fa-phone"></i> ${echapperHTML(num.numero)}</div>
                        <div><i class="fas fa-calendar-alt"></i> Date: ${dateFormatee}</div>
                    </div>
                </div>`;
            });
            
            listeAttente.innerHTML = htmlAttente || '<div class="item-row">Aucune demande en attente</div>';
            listeApprouves.innerHTML = htmlApprouves || '<div class="item-row">Aucun numéro approuvé</div>';
        }
        
        function afficherUtilisateurs() { 
            const liste = document.getElementById('utilisateurs-liste'); 
            if(!liste) return; 
            let filtres = Object.values(utilisateurs); 
            if(rechercheUtilisateurs) filtres = filtres.filter(u => u.nom?.toLowerCase().includes(rechercheUtilisateurs) || u.email?.toLowerCase().includes(rechercheUtilisateurs)); 
            if(filtres.length === 0){ liste.innerHTML='<div class="item-row">Aucun utilisateur</div>'; return; } 
            liste.innerHTML = filtres.map((u,i)=>`<div class="user-item"><div class="user-header"><div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;"><span class="user-name"><i class="fas fa-user-circle"></i> ${echapperHTML(u.nom)}</span><span style="background:var(--accent);padding:4px 10px;border-radius:40px;font-size:0.8rem;">${echapperHTML(u.id||'ID inconnu')}</span></div><button class="btn btn-warning" style="font-size: 0.8rem; padding: 6px 12px; height: 32px; border:none; border-radius:40px; cursor:pointer;" onclick="reinitialiserMotDePasseUtilisateur('${echapperHTML(u.email)}')"><i class="fas fa-key"></i> Réinitialiser MDP</button></div><div class="user-email"><i class="fas fa-envelope"></i> ${echapperHTML(u.email||'Email non renseigné')}</div><div class="user-detail"><span style="margin-right:15px;"><i class="fas fa-calendar"></i> ${echapperHTML(new Date(u.dateInscription).toLocaleDateString())}</span><span><i class="fas fa-phone"></i> ${Object.keys(u.numeros||{}).length} numéro(s)</span></div><div class="user-stats"><span><i class="fas fa-users"></i> Filleuls: ${u.filleulsCount || 0}</span><span><i class="fas fa-ticket-alt"></i> Tours gratuits: ${u.toursGratuits || 0}</span>${u.parrainId ? `<span><i class="fas fa-link"></i> Parrain: ${utilisateurs[u.parrainId]?.nom || 'Inconnu'}</span>` : ''}</div></div>`).join(''); 
        }
        
        function afficherNews(){ const liste=document.getElementById('news-liste'); if(!liste) return; if(!donnees.news||donnees.news.length===0){ liste.innerHTML='<div class="no-news"><i class="fas fa-newspaper"></i><p>Aucune actualité publiée</p></div>'; return; } const newsTriees=[...donnees.news].sort((a,b)=>new Date(b.date)-new Date(a.date)); liste.innerHTML=newsTriees.map(news=>{ const dateObj=new Date(news.date); const dateFormatee=dateObj.toLocaleDateString('fr-FR')+' à '+dateObj.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}); const statut=news.statut!==false?'active':'archive'; return `<div class="news-item-admin"><div class="news-header-admin"><div class="news-titre-admin"><i class="fas ${news.important?'fa-exclamation-circle':'fa-newspaper'}" style="color: var(--accent);"></i> ${echapperHTML(news.titre)}</div><div class="item-actions"><button class="btn btn-edit" onclick="editerNews('${echapperHTML(news.id)}')"><i class="fas fa-edit"></i></button><button class="btn btn-delete" onclick="supprimerNews('${echapperHTML(news.id)}')"><i class="fas fa-trash"></i></button></div></div><div class="news-contenu-admin">${echapperHTML(news.contenu)}</div><div class="news-footer-admin"><div><span class="news-author"><i class="fas fa-user-shield"></i> ${echapperHTML(news.auteur||'Typh Exchange')}</span><span class="news-date-admin" style="margin-left: 10px;"><i class="far fa-calendar-alt"></i> ${echapperHTML(dateFormatee)}</span></div><div style="display: flex; gap: 10px;">${news.important?'<span class="news-important"><i class="fas fa-star"></i> IMPORTANT</span>':''}<span class="news-statut-badge ${statut==='active'?'news-statut-active':'news-statut-archive'}">${statut==='active'?'✓ Visible':'🗄️ Archivée'}</span></div></div></div>`; }).join(''); }
        
        function afficherRoue(){ 
            const l=document.getElementById('roue-liste'); 
            if(!l) return; 
            let tr = Array.isArray(donnees.roue) ? donnees.roue : (typeof donnees.roue === 'object' && donnees.roue !== null ? Object.values(donnees.roue) : []);
            donnees.roue = tr.filter(item => item !== null);
            if(!donnees.roue||donnees.roue.length===0){ 
                l.innerHTML='<div class="item-row">Aucun lot configuré</div>'; 
                document.getElementById('roue-total-prob').innerHTML='Total Probabilité: <span style="color:var(--danger);">0%</span>'; 
                return; 
            } 
            let t=0; 
            l.innerHTML=donnees.roue.map((r,i)=>{ 
                t+=parseFloat(r.probabilite)||0; 
                let typeIcon = r.type === 'crypto' ? 'fa-coins' : (r.type === 'fiat' ? 'fa-money-bill' : 'fa-face-frown');
                let typeColor = r.type === 'crypto' ? 'var(--binance)' : (r.type === 'fiat' ? 'var(--success)' : 'var(--warning)');
                return `<div class="roue-lot-item">
                    <div class="roue-lot-info">
                        <div class="roue-lot-nom"><i class="fas ${typeIcon}" style="color:${typeColor}; margin-right:8px;"></i> ${echapperHTML(r.nom)}</div>
                        <div class="roue-lot-type">Type: ${r.type.toUpperCase()}</div>
                    </div>
                    <div class="roue-lot-prob">${r.probabilite}%</div>
                    <div class="item-actions" style="margin-left:10px;">
                        <button class="btn btn-edit" onclick="ouvrirModal('roue',${i})" style="padding:6px 12px;"><i class="fas fa-edit"></i></button>
                        <button class="btn btn-delete" onclick="supprimer('roue',${i})" style="padding:6px 12px;"><i class="fas fa-trash"></i></button>
                    </div>
                </div>`; 
            }).join(''); 
            document.getElementById('roue-prob-total').textContent = t;
            const el=document.getElementById('roue-total-prob'); 
            if(el) el.innerHTML=`Total Probabilité: <span style="color:${Math.abs(t-100)<0.01?'var(--success)':'var(--danger)'};">${t}%</span> ${Math.abs(t-100)>0.01?'(Attention: le total doit être exactement 100%)':''}`; 
        }
        
        function afficherParrainages() {
            const liste = document.getElementById('parrainages-liste');
            if(!liste) return;
            const recherche = document.getElementById('recherche-parrain')?.value.toLowerCase() || '';
            let html = '';
            let totalParrainages = 0;
            let totalToursOfferts = 0;
            let totalToursUtilises = 0;
            
            Object.entries(utilisateurs).forEach(([uid, user]) => {
                if(!user.parrainId && (!user.filleulsCount || user.filleulsCount === 0)) return;
                
                const userNom = (user.nom || '').toLowerCase();
                const userEmail = (user.email || '').toLowerCase();
                const userId = (user.id || uid.substring(0,8)).toLowerCase();
                const correspondRecherche = recherche === '' || userNom.includes(recherche) || userEmail.includes(recherche) || userId.includes(recherche);
                if(!correspondRecherche) return;
                
                if(user.parrainId) {
                    const parrainData = utilisateurs[user.parrainId];
                    const parrainNom = parrainData?.nom || 'Inconnu';
                    const aNumeroApprouve = user.numeros ? Object.values(user.numeros).some(n => n.statut === 'approuve') : false;
                    const bonusDonne = user.bonusParrainageDonne || false;
                    html += `<div class="user-item">
                        <div class="user-header">
                            <span class="user-name"><i class="fas fa-user-friends"></i> ${echapperHTML(user.nom)}</span>
                            <span class="user-email">${echapperHTML(user.email)}</span>
                        </div>
                        <div class="user-stats">
                            <span><i class="fas fa-link"></i> Parrain: ${echapperHTML(parrainNom)}</span>
                            <span><i class="fas fa-phone-alt"></i> Numéro: ${aNumeroApprouve ? '✅ Approuvé' : '⏳ En attente'}</span>
                            <span><i class="fas fa-gift"></i> Bonus: ${bonusDonne ? '✅ Donné' : '❌ Non donné'}</span>
                        </div>
                    </div>`;
                }
                
                if(user.filleulsCount && user.filleulsCount > 0) {
                    totalParrainages += user.filleulsCount;
                    totalToursOfferts += user.filleulsCount;
                    totalToursUtilises += (user.filleulsCount - (user.toursGratuits || 0));
                    html += `<div class="user-item" style="border-left: 3px solid var(--affiliate);">
                        <div class="user-header">
                            <span class="user-name"><i class="fas fa-crown"></i> ${echapperHTML(user.nom)} (Parrain)</span>
                            <span class="user-email">${echapperHTML(user.email)}</span>
                        </div>
                        <div class="user-stats">
                            <span><i class="fas fa-users"></i> Filleuls: ${user.filleulsCount}</span>
                            <span><i class="fas fa-ticket-alt"></i> Tours gratuits: ${user.toursGratuits || 0}</span>
                            <span><i class="fas fa-check-circle"></i> Tours utilisés: ${(user.filleulsCount - (user.toursGratuits || 0))}</span>
                        </div>
                    </div>`;
                }
            });
            
            document.getElementById('stat-total-parrainages').textContent = totalParrainages;
            document.getElementById('stat-tours-offerts').textContent = totalToursOfferts;
            document.getElementById('stat-tours-utilises').textContent = totalToursUtilises;
            
            liste.innerHTML = html || '<div class="item-row">Aucune donnée de parrainage</div>';
        }
        
        async function forcerEnvoiBonusParrainage() {
            if(!confirm("⚠️ Cette action va vérifier TOUS les utilisateurs et attribuer les tours gratuits aux parrains qui ont des filleuls avec numéro approuvé mais qui n'ont pas encore reçu leur bonus.\n\nContinuer ?")) return;
            let bonusDistribues = 0;
            let utilisateursTraites = 0;
            let errors = [];
            for (const [uid, userData] of Object.entries(utilisateurs)) {
                if (userData.parrainId && !userData.bonusParrainageDonne) {
                    let aNumeroApprouve = false;
                    if (userData.numeros) {
                        aNumeroApprouve = Object.values(userData.numeros).some(num => num.statut === 'approuve');
                    }
                    if (aNumeroApprouve) {
                        const parrainId = userData.parrainId;
                        const parrainRef = database.ref(`donnees/utilisateurs/${parrainId}`);
                        const parrainSnap = await parrainRef.once('value');
                        const parrainData = parrainSnap.val();
                        if (parrainData) {
                            const nouveauxTours = (parrainData.toursGratuits || 0) + 1;
                            const nouveauxFilleuls = (parrainData.filleulsCount || 0) + 1;
                            await parrainRef.update({ toursGratuits: nouveauxTours, filleulsCount: nouveauxFilleuls });
                            await database.ref(`donnees/utilisateurs/${uid}`).update({ bonusParrainageDonne: true });
                            bonusDistribues++;
                            utilisateursTraites++;
                        } else {
                            errors.push(`Parrain introuvable pour ${userData.nom} (ID: ${userData.parrainId})`);
                        }
                    } else {
                        utilisateursTraites++;
                    }
                }
            }
            await rafraichirUtilisateurs();
            afficherParrainages();
            if (bonusDistribues > 0) {
                alert(`✅ Opération terminée !\n\n${bonusDistribues} bonus distribués avec succès.\n${errors.length} erreur(s).`);
            } else {
                alert(`ℹ️ Aucun nouveau bonus à distribuer.\n\nTous les parrains ont déjà reçu leurs tours gratuits.`);
            }
            if (errors.length > 0) console.error("Erreurs:", errors);
        }
        
        function mettreAJourStats() { 
            let numerosAttente = 0; 
            let totalParrainages = 0;
            Object.values(utilisateurs).forEach(user => { 
                if(user.numeros) numerosAttente += Object.values(user.numeros).filter(n => n.statut === 'en_attente').length;
                if(user.filleulsCount) totalParrainages += user.filleulsCount;
            }); 
            const demandesArray = getDemandesTableau();
            const demandesAchatVente = demandesArray.filter(d => d.type === 'ACHAT' || d.type === 'VENTE');
            document.getElementById('stats-utilisateurs').textContent = Object.keys(utilisateurs).length; 
            document.getElementById('stats-numeros-attente').textContent = numerosAttente; 
            document.getElementById('stats-demandes').textContent = demandesAchatVente.length; 
            document.getElementById('stats-transactions').textContent = demandesAchatVente.filter(d => d.statut === 'confirme').length; 
            document.getElementById('stats-transactions-attente').textContent = demandesAchatVente.filter(d => d.statut === 'en_attente').length;
            document.getElementById('stats-parrainages').textContent = totalParrainages;
            mettreAJourBadgeNumeros();
        }
        
        function mettreAJourBadgeNumeros() {
            let numerosAttente = 0;
            Object.values(utilisateurs).forEach(user => {
                if(user.numeros) numerosAttente += Object.values(user.numeros).filter(n => n.statut === 'en_attente').length;
            });
            const badge = document.getElementById('notif-numeros');
            if(badge) {
                if(numerosAttente > 0) {
                    badge.textContent = numerosAttente;
                    badge.style.display = 'inline-block';
                } else {
                    badge.style.display = 'none';
                }
            }
        }
        
        function rafraichirUtilisateurs() { 
            const now = Date.now();
            if (now - dernierRafraichissementUtilisateurs < 60000) return; // 1 minute minimum
            dernierRafraichissementUtilisateurs = now;
            
            database.ref('donnees/utilisateurs').once('value').then((snap) => { 
                utilisateurs = snap.val() || {}; 
                mettreAJourStats(); 
                afficherNumeros(); 
                afficherUtilisateurs(); 
                afficherParrainages(); 
            }).catch(e => console.error(e)); 
        }
        
        function rafraichirNumeros() { rafraichirUtilisateurs(); afficherNumeros(); }
        
        async function approuverNumero(uid, numeroId) { 
            if(!assertAdminSession()) return;
            if(!confirm('✅ Approuver ce numéro ?')) return; 
            const result = await callCloudFunction('adminApproveNumber', { uid, numeroId });
            alert(result.referralAwarded ? '✅ Numéro approuvé ! 1 tour gratuit a été ajouté au parrain.' : '✅ Numéro approuvé !');
            rafraichirUtilisateurs();
        }
        
        async function rejeterNumero(uid, numeroId) { if(!assertAdminSession()) return; if(!confirm('❌ Rejeter ce numéro ?')) return; try { await callCloudFunction('adminRejectNumber', { uid, numeroId }); alert('Numéro rejeté'); rafraichirUtilisateurs(); } catch (err) { console.error(err); } }
        
        function filtrerUtilisateurs(){ rechercheUtilisateurs=document.getElementById('recherche-utilisateur')?.value.toLowerCase()||''; afficherUtilisateurs(); }
        
        function reinitialiserMotDePasseUtilisateur(email) {
            if (!assertAdminSession()) return;
            if (!email || email === 'undefined' || email === 'Email non renseigné') { alert('Email invalide pour cet utilisateur.'); return; }
            if (confirm(`Envoyer un lien de réinitialisation de mot de passe à ${email} ?`)) {
                auth.sendPasswordResetEmail(email).then(() => { alert(`✅ Lien de réinitialisation envoyé à ${email}.`); }).catch((error) => { console.error(error); alert(`❌ Erreur : ${error.message}`); });
            }
        }
        
        function voirDetailsTransaction(id){ 
            const demandesArray = getDemandesTableau();
            const tx=demandesArray?.find(d=>d.id===id); 
            if(!tx) return; 
            transactionSelectionneeId=id; 
            let html=`<div class="info-row"><span class="info-label">ID:</span><span class="info-value">${echapperHTML(tx.id)}</span></div><div class="info-row"><span class="info-label">ID Client:</span><span class="info-value">${echapperHTML(tx.userID||'Non attribué')}</span></div><div class="info-row"><span class="info-label">Type:</span><span class="info-value" style="color:${tx.type==='ACHAT'?'var(--success)':(tx.type==='VENTE'?'var(--warning)':'var(--bonus)')}"><i class="fas ${tx.type==='ACHAT'?'fa-arrow-down':(tx.type==='VENTE'?'fa-arrow-up':'fa-gift')}"></i> ${echapperHTML(tx.type)}</span></div><div class="info-row"><span class="info-label">Statut:</span><span class="info-value badge-statut ${tx.statut}">${echapperHTML(tx.statut)}</span></div><div class="info-row"><span class="info-label">Client:</span><span class="info-value">${echapperHTML(tx.utilisateur)}</span></div><div class="info-row"><span class="info-label">Email:</span><span class="info-value">${echapperHTML(tx.email)}</span></div><div class="info-row"><span class="info-label">Date:</span><span class="info-value">${echapperHTML(new Date(tx.date).toLocaleString())}</span></div>`; 
            if(tx.type==='ACHAT'){ 
                html+=`<div class="info-row"><span class="info-label">Vous recevez:</span><span class="info-value" style="color:var(--success);font-weight:700;">${tx.montantRecu?tx.montantRecu.toFixed(4)+' '+tx.crypto:'Calcul...'}</span></div><div class="info-row"><span class="info-label">Opérateur:</span><span class="info-value">${echapperHTML(tx.operateur||'N/A')}</span></div><div class="info-row"><span class="info-label">Montant envoyé:</span><span class="info-value">${echapperHTML(tx.montant)} Ar</span></div><div class="info-row"><span class="info-label">Réseau:</span><span class="info-value">${echapperHTML(tx.reseau||'N/A')}</span></div><div class="info-row"><span class="info-label">Portefeuille:</span><span class="info-value">${echapperHTML(tx.portefeuille||'N/A')}</span></div><div class="info-row"><span class="info-label">Adresse:</span><span class="info-value" style="word-break:break-all;">${echapperHTML(tx.adresse||'N/A')}</span></div><div class="info-row"><span class="info-label">Numéro débité:</span><span class="info-value">${tx.nomNumero?echapperHTML(tx.nomNumero)+' ('+echapperHTML(tx.numero)+')':echapperHTML(tx.numero||'Non spécifié')}</span></div>`; 
            } else if(tx.type==='VENTE') { 
                html+=`<div class="info-row"><span class="info-label">Vous recevez:</span><span class="info-value" style="color:var(--success);font-weight:700;">${tx.montantRecu?tx.montantRecu.toLocaleString()+' Ar':'Calcul...'}</span></div><div class="info-row"><span class="info-label">Crypto envoyée:</span><span class="info-value">${echapperHTML(tx.montant)} ${echapperHTML(tx.crypto)}</span></div><div class="info-row"><span class="info-label">Réseau:</span><span class="info-value">${echapperHTML(tx.reseau||'N/A')}</span></div><div class="info-row"><span class="info-label">Opérateur:</span><span class="info-value">${echapperHTML(tx.operateur||'N/A')}</span></div><div class="info-row"><span class="info-label">Portefeuille:</span><span class="info-value">${echapperHTML(tx.portefeuille||'N/A')}</span></div><div class="info-row"><span class="info-label">Bénéficiaire:</span><span class="info-value">${echapperHTML(tx.nomNumero||tx.utilisateur)}</span></div><div class="info-row"><span class="info-label">Numéro crédité:</span><span class="info-value">${echapperHTML(tx.numero||'N/A')}</span></div>`; 
                if (tx.adresseLiee) { html+=`<div class="info-row" style="background: rgba(59,130,246,0.1); padding: 12px; border-radius: 12px; border: 1px solid var(--accent); margin-top: 10px; display: block;"><span class="info-label" style="color:var(--accent); width:100%; margin-bottom:8px; display:block; font-weight:700;"><i class="fas fa-link"></i> Adresse de réception du client:</span><span class="info-value" style="word-break:break-all; color:var(--white); font-weight:bold; display:block;">${echapperHTML(tx.adresseLiee)}</span></div>`; }
            } else if(tx.type==='BONUS') {
                html+=`<div class="info-row"><span class="info-label">Lot gagné:</span><span class="info-value" style="color:var(--bonus);font-weight:700;">${echapperHTML(tx.lotGagne || tx.montant)}</span></div><div class="info-row" style="background: rgba(139,92,246,0.1); padding: 12px; border-radius: 12px; border: 1px solid var(--bonus); margin-top: 10px; display: block;"><span class="info-label" style="color:var(--bonus); width:100%; margin-bottom:8px; display:block; font-weight:700;"><i class="fas fa-map-marker-alt"></i> 📍 Info réception (entrée par l'utilisateur):</span><span class="info-value" style="word-break:break-all; color:var(--white); font-weight:bold; display:block;">${echapperHTML(tx.adresse || tx.numero || 'N/A')}</span></div>`;
            }
            html+=`<div class="info-row"><span class="info-label">TXID/Preuve:</span><span class="info-value" style="word-break:break-all;">${echapperHTML(tx.txid||'Non fourni')}</span></div>${tx.messagePaiement?`<div class="info-row"><span class="info-label">Message:</span><span class="info-value">${echapperHTML(tx.messagePaiement)}</span></div>`:''}`; 
            document.getElementById('details-transaction-complete').innerHTML=html; 
            let histHtml=''; 
            if(tx.historique&&tx.historique.length>0){ 
                histHtml=tx.historique.sort((a,b)=>new Date(b.date)-new Date(a.date)).map(h=>`<div class="historique-item"><span class="historique-date">${echapperHTML(new Date(h.date).toLocaleString())}</span><span class="historique-action">${echapperHTML(h.action)}</span></div>`).join(''); 
            } else{ 
                histHtml='<div class="historique-item">Aucun historique</div>'; 
            } 
            document.getElementById('historique-transaction').innerHTML=histHtml; 
            document.getElementById('modal-changer-statut').value=tx.statut; 
            document.getElementById('modal-note-transaction').value=tx.notes||''; 
            document.getElementById('modal-details-transaction').classList.add('active'); 
        }
        
        function fermerModalTransaction(){ document.getElementById('modal-details-transaction').classList.remove('active'); transactionSelectionneeId=null; }
        
        async function changerStatutTransaction(){ 
            if(!transactionSelectionneeId) return; 
            const ns=document.getElementById('modal-changer-statut').value; 
            await callCloudFunction('adminUpdateTransactionStatus', { id: transactionSelectionneeId, status: ns });
            await chargerDonnees();
            alert(`✅ Statut changé à ${ns} et sauvegardé`); 
            voirDetailsTransaction(transactionSelectionneeId); 
            afficherTransactions(); 
            afficherBonus();
            verifierNouvellesTransactions(); 
        }
        
        function ajouterNoteTransaction(){ 
            if(!transactionSelectionneeId) return; 
            const note=document.getElementById('modal-note-transaction').value.trim(); 
            if(!note) return; 
            const demandesArray = getDemandesTableau();
            const tx=demandesArray?.find(d=>d.id===transactionSelectionneeId); 
            if(tx){ 
                if(!tx.notes) tx.notes=''; 
                tx.notes+=(tx.notes?'\n':'')+`[${new Date().toLocaleString()}] ${note}`; 
                tx.lastModified = Date.now();
                if(!tx.historique) tx.historique=[]; 
                tx.historique.push({date:new Date().toISOString(),action:'NOTE_AJOUTEE',details:note}); 
                sauvegarderDemandes(demandesArray);
                document.getElementById('modal-note-transaction').value=''; 
                alert('✅ Note ajoutée'); 
                voirDetailsTransaction(transactionSelectionneeId); 
            } 
        }
        
        function telechargerRecu(){ 
            if(!transactionSelectionneeId){ alert('Aucune transaction sélectionnée'); return; } 
            const demandesArray = getDemandesTableau();
            const tx=demandesArray?.find(d=>d.id===transactionSelectionneeId); 
            if(!tx){ alert('Transaction introuvable'); return; } 
            const recu=document.getElementById('recu-contenu'); 
            const dateGen=document.getElementById('recu-date-generation'); 
            let montantRecu = '';
            if(tx.type==='ACHAT') montantRecu = (tx.montantRecu?tx.montantRecu.toFixed(4):'0')+' '+tx.crypto;
            else if(tx.type==='VENTE') montantRecu = (tx.montantRecu?tx.montantRecu.toLocaleString():'0')+' Ar';
            else if(tx.type==='BONUS') montantRecu = tx.lotGagne || tx.montant || 'N/A';
            let adresseLieeHtml = tx.adresseLiee ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Adresse de liaison:</strong><td style="padding:8px;border-bottom:1px solid #eee;">${echapperHTML(tx.adresseLiee)}</td></tr>` : '';
            let beneficiaire = '';
            if(tx.type==='ACHAT'){ beneficiaire = `<tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Adresse:</strong><td style="padding:8px;border-bottom:1px solid #eee;">${echapperHTML(tx.adresse||'Non spécifiée')}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Numéro débité:</strong><td style="padding:8px;border-bottom:1px solid #eee;">${tx.nomNumero?echapperHTML(tx.nomNumero)+' ('+echapperHTML(tx.numero)+')':echapperHTML(tx.numero||'Non spécifié')}</td></tr>`; }
            else if(tx.type==='VENTE'){ beneficiaire = `<tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Bénéficiaire:</strong><td style="padding:8px;border-bottom:1px solid #eee;">${echapperHTML(tx.nomNumero||tx.utilisateur)}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Numéro crédité:</strong><td style="padding:8px;border-bottom:1px solid #eee;">${echapperHTML(tx.numero||'Non spécifié')}</td></tr>${adresseLieeHtml}`; }
            else if(tx.type==='BONUS'){ beneficiaire = `<tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Info Réception:</strong><td style="padding:8px;border-bottom:1px solid #eee;">${echapperHTML(tx.adresse || tx.numero || 'N/A')}</td></tr>`; }
            let montantEnvoyeHtml = tx.type !== 'BONUS' ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Montant envoyé:</strong><td style="padding:8px;border-bottom:1px solid #eee;">${echapperHTML(tx.montant)} ${tx.type==='ACHAT'?'Ar':tx.crypto}</td></tr>` : '';
            let reseauHtml = tx.type !== 'BONUS' ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Réseau:</strong><td style="padding:8px;border-bottom:1px solid #eee;">${echapperHTML(tx.reseau||'N/A')}</td></tr>` : '';
            recu.innerHTML=`<table style="width:100%;border-collapse:collapse;margin:20px 0;"><tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>ID Transaction:</strong><td style="padding:8px;border-bottom:1px solid #eee;">${echapperHTML(tx.id)}</td></tr>
                       <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>ID Client:</strong><td style="padding:8px;border-bottom:1px solid #eee;">${echapperHTML(tx.userID||'Non attribué')}</td></tr>
                       <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Type:</strong><td style="padding:8px;border-bottom:1px solid #eee;">${echapperHTML(tx.type)}</td></tr>
                       <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Statut:</strong><td style="padding:8px;border-bottom:1px solid #eee;">${echapperHTML(tx.statut)}</td></tr>
                       <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Client:</strong><td style="padding:8px;border-bottom:1px solid #eee;">${echapperHTML(tx.utilisateur)}</td></tr>
                       <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Email:</strong><td style="padding:8px;border-bottom:1px solid #eee;">${echapperHTML(tx.email)}</td></tr>
                       <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>Date:</strong><td style="padding:8px;border-bottom:1px solid #eee;">${echapperHTML(new Date(tx.date).toLocaleString('fr-FR'))}</td></tr>
                    ${montantEnvoyeHtml}
                    <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>${tx.type==='BONUS'?'Lot gagné':'Vous recevez'}:</strong><td style="padding:8px;border-bottom:1px solid #eee;color:#059669;font-weight:bold;">${echapperHTML(montantRecu)}</td></tr>
                    ${reseauHtml}
                    ${beneficiaire}
                    <tr><td style="padding:8px;border-bottom:1px solid #eee;"><strong>TXID/Preuve:</strong><td style="padding:8px;border-bottom:1px solid #eee;font-size:0.8rem;word-break:break-all;">${echapperHTML(tx.txid||'Non fourni')}</td></tr>
                 </table>`; 
            dateGen.textContent=echapperHTML(new Date().toLocaleString('fr-FR')); 
            html2canvas(document.getElementById('template-recu'),{scale:2,backgroundColor:'#ffffff',logging:false}).then(canvas=>{ const a=document.createElement('a'); a.download=`recu-${tx.id}-${Date.now()}.png`; a.href=canvas.toDataURL('image/png'); a.click(); const demandesArray2 = getDemandesTableau();
            const tx2=demandesArray2.find(d=>d.id===tx.id); if(tx2){ if(!tx2.historique) tx2.historique=[]; tx2.historique.push({date:new Date().toISOString(),action:'RECU_TELECHARGE',details:'Reçu téléchargé par admin'}); sauvegarderDemandes(demandesArray2); } }).catch(e=>{ console.error(e); alert('❌ Erreur génération reçu'); }); 
        }
        
        function filtrerTransactions(){ afficherTransactions(); calculerStatsTransactions(); }
        
        function demarrerSurveillanceTransactions() { if(intervalNotification) clearInterval(intervalNotification); intervalNotification = setInterval(() => verifierNouvellesTransactions(), 60000); verifierNouvellesTransactions(); }
        
        function verifierNouvellesTransactions() { 
            const demandesArray = getDemandesTableau();
            const enAttente = demandesArray.filter(d => d.statut === 'en_attente' && d.type !== 'BONUS').length; 
            const badge = document.getElementById('notif-transactions'); 
            if (badge) { 
                if (enAttente > 0) { 
                    badge.textContent = enAttente; 
                    badge.style.display = 'inline-block'; 
                    if (enAttente > dernierCompteTransactions) { 
                        badge.style.background = 'var(--danger)'; 
                        badge.style.animation = 'pulse 1.5s infinite'; 
                    } else { 
                        badge.style.background = 'var(--warning)'; 
                        badge.style.animation = 'none'; 
                    } 
                } else { 
                    badge.style.display = 'none'; 
                } 
            }
            const bonusAttente = demandesArray.filter(d => d.statut === 'en_attente' && d.type === 'BONUS').length;
            const badgeBonus = document.getElementById('notif-bonus');
            if(badgeBonus) {
                if(bonusAttente > 0) {
                    badgeBonus.textContent = bonusAttente;
                    badgeBonus.style.display = 'inline-block';
                    if(bonusAttente > dernierCompteBonus) {
                        badgeBonus.style.background = 'var(--danger)';
                        badgeBonus.style.animation = 'pulse 1.5s infinite';
                    } else {
                        badgeBonus.style.background = 'var(--warning)';
                        badgeBonus.style.animation = 'none';
                    }
                } else {
                    badgeBonus.style.display = 'none';
                }
            }
            if (enAttente > dernierCompteTransactions) { 
                const nouvelles = enAttente - dernierCompteTransactions; 
                if (nouvelles <= 3) afficherNotification(`${nouvelles} nouvelle(s) transaction(s) en attente`); 
                const nouvellesTransactions = demandesArray.filter(d => d.statut === 'en_attente' && d.type !== 'BONUS' && (new Date() - new Date(d.date)) < 600000); 
                nouvellesTransactions.slice(0, 3).forEach(tx => envoyerNotificationTransaction(tx)); 
            }
            if (bonusAttente > dernierCompteBonus) {
                const nouvelles = bonusAttente - dernierCompteBonus;
                if (nouvelles <= 3) afficherNotification(`🎰 ${nouvelles} nouveau(x) bonus roue en attente`);
                const nouveauxBonus = demandesArray.filter(d => d.statut === 'en_attente' && d.type === 'BONUS' && (new Date() - new Date(d.date)) < 600000);
                nouveauxBonus.slice(0, 3).forEach(tx => envoyerNotificationTransaction(tx));
            }
            dernierCompteTransactions = enAttente;
            dernierCompteBonus = bonusAttente;
        }
        
        function envoyerNotificationTransaction(transaction) { 
            if (!notificationPermission) return; 
            jouerSonNotification();
            let montant = ''; 
            if(transaction.type === 'ACHAT') montant = `${transaction.montant} Ar → ${transaction.montantRecu?.toFixed(4)} ${transaction.crypto}`; 
            else if(transaction.type === 'VENTE') montant = `${transaction.montant} ${transaction.crypto} → ${transaction.montantRecu?.toLocaleString()} Ar`; 
            else if(transaction.type === 'BONUS') montant = `🎰 Bonus: ${transaction.lotGagne || transaction.montant}`; 
            const notification = new Notification('💰 Nouvelle transaction en attente', { 
                body: `${transaction.utilisateur} - ${transaction.type}: ${montant}`, 
                vibrate: [200,100,200], 
                tag: transaction.id, 
                actions: [{ action: 'view', title: '👁️ Voir' }, { action: 'approve', title: '✅ Approuver' }, { action: 'reject', title: '❌ Rejeter' }] 
            }); 
            notification.onclick = function() { 
                window.focus(); 
                if(transaction.type === 'BONUS') switchTab('bonusroue'); 
                else switchTab('transactions'); 
                voirDetailsTransaction(transaction.id); 
                this.close(); 
            }; 
            notification.onaction = function(e) { 
                window.focus(); 
                if(transaction.type === 'BONUS') switchTab('bonusroue'); 
                else switchTab('transactions'); 
                if (e.action === 'view') voirDetailsTransaction(transaction.id); 
                else if (e.action === 'approve') setTimeout(() => approuverDemande(transaction.id), 500); 
                else if (e.action === 'reject') setTimeout(() => rejeterDemande(transaction.id), 500); 
                this.close(); 
            }; 
        }
        
        function afficherNotification(message) { const toast = document.getElementById('notification-toast'); if (!toast) return; document.getElementById('toast-message').textContent = message; toast.classList.add('show'); if (toastTimer) clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 5000); }
        function fermerToast() { const toast = document.getElementById('notification-toast'); if (toast) { toast.classList.remove('show'); if (toastTimer) clearTimeout(toastTimer); } }
        function verifierPermissionNotification() { if (!('Notification' in window)) return; if (Notification.permission === 'granted') notificationPermission = true; else if (Notification.permission === 'default' && !localStorage.getItem('notificationPermission')) setTimeout(() => { document.getElementById('notification-permission-banner').style.display = 'block'; }, 5000); }
        function demanderPermissionNotification() { Notification.requestPermission().then(p => { if (p === 'granted') { notificationPermission = true; document.getElementById('notification-permission-banner').style.display = 'none'; localStorage.setItem('notificationPermission', 'granted'); } }); }
        function fermerBannerPermission() { document.getElementById('notification-permission-banner').style.display = 'none'; localStorage.setItem('notificationPermission', 'declined'); }
        
        function switchTab(tab){ 
            document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active')); 
            ['gestion','taux','pause','utilisateurs','numeros','demandes','news','transactions','bonusroue','config','roue','parrainage'].forEach(t=>document.getElementById(t+'-tab').style.display='none'); 
            const tabsMap = { gestion:0, taux:1, pause:2, utilisateurs:3, numeros:4, demandes:5, news:6, transactions:7, bonusroue:8, config:9, roue:10, parrainage:11 };
            const idx = tabsMap[tab];
            if(idx !== undefined) document.querySelectorAll('.tab')[idx]?.classList.add('active');
            document.getElementById(tab+'-tab').style.display='block';
            if(tab === 'transactions'){ afficherTransactions(); calculerStatsTransactions(); if(document.getElementById('notif-transactions')) document.getElementById('notif-transactions').style.background='var(--warning)'; }
            if(tab === 'bonusroue'){ afficherBonus(); }
            if(tab === 'numeros'){ afficherNumeros(); }
            if(tab === 'roue'){ afficherRoue(); }
            if(tab === 'parrainage'){ afficherParrainages(); }
        }
        
        function editerNews(id){ const n=donnees.news.find(n=>n.id===id); if(!n) return; document.getElementById('news-editing-id').value=id; document.getElementById('news-titre').value=n.titre; document.getElementById('news-contenu').value=n.contenu; document.getElementById('news-auteur').value=n.auteur||'Typh Exchange'; document.getElementById('news-important').checked=n.important||false; document.getElementById('news-statut').checked=n.statut!==false; document.getElementById('news-form-title').innerHTML='<i class="fas fa-edit"></i> Modifier l\'actualité'; document.getElementById('btn-annuler-news').style.display='block'; }
        function annulerEditionNews(){ document.getElementById('news-editing-id').value=''; document.getElementById('news-titre').value=''; document.getElementById('news-contenu').value=''; document.getElementById('news-auteur').value='Typh Exchange'; document.getElementById('news-important').checked=false; document.getElementById('news-statut').checked=true; document.getElementById('news-form-title').innerHTML='<i class="fas fa-plus-circle"></i> Ajouter une actualité'; document.getElementById('btn-annuler-news').style.display='none'; }
        function sauvegarderNews(){ if(!assertAdminSession()) return; const titre=document.getElementById('news-titre').value.trim(); const contenu=document.getElementById('news-contenu').value.trim(); const auteur=document.getElementById('news-auteur').value.trim()||'Typh Exchange'; const important=document.getElementById('news-important').checked; const actif=document.getElementById('news-statut').checked; if(!titre||!contenu){ alert('Veuillez remplir tous les champs'); return; } if(!donnees.news) donnees.news=[]; const id=document.getElementById('news-editing-id').value; if(id){ const idx=donnees.news.findIndex(n=>n.id===id); if(idx!==-1){ donnees.news[idx]={...donnees.news[idx],titre,contenu,auteur,important,statut:actif,dateModification:new Date().toISOString()}; } } else { donnees.news.push({id:'NEWS-'+Date.now()+'-'+Math.random().toString(36).substr(2,9),titre,contenu,auteur,important,statut:actif,date:new Date().toISOString()}); } database.ref('donnees/news').set(donnees.news); annulerEditionNews(); afficherNews(); alert('✅ Actualité enregistrée avec succès'); }
        function supprimerNews(id){ if(!assertAdminSession()) return; if(!confirm('❌ Supprimer cette actualité ?')) return; donnees.news=donnees.news.filter(n=>n.id!==id); database.ref('donnees/news').set(donnees.news); afficherNews(); alert('✅ Actualité supprimée'); }
        
        function supprimer(type,idx){ if(!assertAdminSession()) return; if(!confirm('Supprimer ?')) return; switch(type){ case 'portefeuille': donnees.portefeuilles.splice(idx,1); database.ref('donnees/portefeuilles').set(donnees.portefeuilles); break; case 'operateur': donnees.operateurs.splice(idx,1); database.ref('donnees/operateurs').set(donnees.operateurs); break; case 'reseau': donnees.reseaux.splice(idx,1); database.ref('donnees/reseaux').set(donnees.reseaux); break; case 'crypto': const c=donnees.cryptos[idx]; donnees.cryptos.splice(idx,1); if(donnees.taux&&donnees.taux[c]) delete donnees.taux[c]; database.ref('donnees/cryptos').set(donnees.cryptos); database.ref('donnees/taux').set(donnees.taux); break; case 'roue': let rData = Array.isArray(donnees.roue) ? donnees.roue : (typeof donnees.roue === 'object' && donnees.roue !== null ? Object.values(donnees.roue) : []); rData = rData.filter(item => item !== null); rData.splice(idx,1); donnees.roue = rData; database.ref('donnees/roue').set(donnees.roue); break; } afficherTout(); }
        
        let modalType, modalIndex, modalMode, modalCryptoNom;
        function ouvrirModal(type,index=-1,cryptoNom=null){ modalType=type; modalIndex=index; modalCryptoNom=cryptoNom; modalMode=index===-1?'ajout':'modification'; const modal=document.getElementById('modal-admin'); const titre=document.getElementById('modal-titre'); const champs=document.getElementById('modal-champs'); let html=''; switch(type){ case 'portefeuille': titre.innerHTML='<i class="fas fa-briefcase"></i> '+(modalMode==='ajout'?'Nouveau portefeuille':'Modifier portefeuille'); if(modalMode==='ajout') html=`<input type="text" id="modal-nom" placeholder="Nom du portefeuille"><textarea id="modal-reponse" placeholder="Description"></textarea><textarea id="modal-message" placeholder="Message de confirmation"></textarea><select id="modal-reseau"><option value="">Sélectionner un réseau</option>${(donnees.reseaux||[]).map(r=>`<option value="${echapperHTML(r.nom)}">${echapperHTML(r.nom)} (${echapperHTML(r.crypto)})</option>`).join('')}</select><div style="margin-top:15px; background:var(--bg-dark); padding:10px; border-radius:10px;"><label style="display:flex; align-items:center; gap:10px; color:var(--text-primary); cursor:pointer;"><input type="checkbox" id="modal-liaison-requise" style="width:18px; height:18px; accent-color:var(--accent);"> Nécessite une liaison d'adresse</label></div>`; else html=`<input type="text" id="modal-nom" value="${echapperHTML(donnees.portefeuilles[index].nom)}"><textarea id="modal-reponse">${echapperHTML(donnees.portefeuilles[index].reponse||'')}</textarea><textarea id="modal-message">${echapperHTML(donnees.portefeuilles[index].messageConfirmation||'')}</textarea><select id="modal-reseau"><option value="">Sélectionner un réseau</option>${(donnees.reseaux||[]).map(r=>`<option value="${echapperHTML(r.nom)}" ${donnees.portefeuilles[index].reseau===r.nom?'selected':''}>${echapperHTML(r.nom)} (${echapperHTML(r.crypto)})</option>`).join('')}</select><div style="margin-top:15px; background:var(--bg-dark); padding:10px; border-radius:10px;"><label style="display:flex; align-items:center; gap:10px; color:var(--text-primary); cursor:pointer;"><input type="checkbox" id="modal-liaison-requise" style="width:18px; height:18px; accent-color:var(--accent);" ${donnees.portefeuilles[index].liaisonRequise ? 'checked' : ''}> Nécessite une liaison d'adresse</label></div>`; break; case 'operateur': titre.innerHTML='<i class="fas fa-mobile-alt"></i> '+(modalMode==='ajout'?'Nouvel opérateur':'Modifier opérateur'); if(modalMode==='ajout') html=`<input type="text" id="modal-nom" placeholder="Nom"><textarea id="modal-message" placeholder="Message de confirmation"></textarea>`; else html=`<input type="text" id="modal-nom" value="${echapperHTML(donnees.operateurs[index].nom)}"><textarea id="modal-message">${echapperHTML(donnees.operateurs[index].messageConfirmation||'')}</textarea>`; break; case 'reseau': titre.innerHTML='<i class="fas fa-network-wired"></i> '+(modalMode==='ajout'?'Nouveau réseau':'Modifier réseau'); if(modalMode==='ajout') html=`<input type="text" id="modal-nom" placeholder="Nom du réseau"><select id="modal-crypto">${(donnees.cryptos||[]).map(c=>`<option value="${echapperHTML(c)}">${echapperHTML(c)}</option>`).join('')}</select><input type="number" id="modal-frais-reseau" placeholder="Frais réseau (%)" step="0.1" min="0">`; else html=`<input type="text" id="modal-nom" value="${echapperHTML(donnees.reseaux[index].nom)}"><select id="modal-crypto">${(donnees.cryptos||[]).map(c=>`<option value="${echapperHTML(c)}" ${donnees.reseaux[index].crypto===c?'selected':''}>${echapperHTML(c)}</option>`).join('')}</select><input type="number" id="modal-frais-reseau" step="0.1" min="0" value="${donnees.reseaux[index].fraisReseau||0}">`; break; case 'crypto': titre.innerHTML='<i class="fas fa-coins"></i> '+(modalMode==='ajout'?'Ajouter crypto':'Modifier crypto'); html=`<input type="text" id="modal-nom" placeholder="Nom (ex: USDT, BTC)" value="${modalMode==='modification'?echapperHTML(donnees.cryptos[index]):''}">`; break; case 'taux': const crypto=cryptoNom||(modalMode==='modification'?Object.keys(donnees.taux)[index]:''); const taux=crypto&&donnees.taux[crypto]?donnees.taux[crypto]:{prixUSD:0,prixMGA:0,variation:"0",couleur:"positive"}; titre.innerHTML=`<i class="fas fa-chart-line"></i> Modifier taux ${echapperHTML(crypto)}`; html=`<input type="hidden" id="modal-crypto" value="${echapperHTML(crypto)}"><div style="margin-bottom:15px;color:var(--text-secondary);">Crypto: <strong>${echapperHTML(crypto)}</strong></div><div style="background:var(--bg-dark);padding:15px;border-radius:20px;margin-bottom:20px;"><div style="display:flex;justify-content:space-between;margin-bottom:10px;"><span>Prix USD:</span><span style="font-weight:600;">$${taux.prixUSD.toFixed(2)}</span></div><div style="display:flex;justify-content:space-between;"><span>Prix MGA:</span><span style="font-weight:600;color:var(--warning);">${taux.prixMGA.toLocaleString()} Ar</span></div></div><input type="number" id="modal-prix-usd" placeholder="Prix USD" step="0.01" value="${taux.prixUSD||0}"><input type="number" id="modal-prix-mga" placeholder="Prix MGA" value="${taux.prixMGA||0}"><input type="text" id="modal-variation" placeholder="Variation %" value="${echapperHTML(taux.variation||'0')}"><select id="modal-couleur"><option value="positive" ${taux.couleur==='positive'?'selected':''}>Positif (+)</option><option value="negative" ${taux.couleur==='negative'?'selected':''}>Négatif (-)</option></select>`; break; case 'roue': titre.innerHTML='<i class="fas fa-gift"></i> '+(modalMode==='ajout'?'Nouveau Lot de la Roue':'Modifier Lot'); let rDef = {nom:'', type:'crypto', probabilite:0}; let rObj = modalMode === 'modification' ? donnees.roue[index] : rDef; html=`<input type="text" id="modal-roue-nom" placeholder="Nom du lot (ex: 5000 Ar ou 1 USDT ou Merci...)" value="${echapperHTML(rObj.nom)}"> 
                    <select id="modal-roue-type" style="width: 100%; padding: 16px; margin-bottom: 16px; background: var(--primary); border: 1px solid var(--gray-300); border-radius: 40px; color: var(--white);">
                        <option value="crypto" ${rObj.type==='crypto'?'selected':''}>💰 Crypto (ex: USDT)</option>
                        <option value="fiat" ${rObj.type==='fiat'?'selected':''}>💵 Ariary (ex: 5000 Ar)</option>
                        <option value="rien" ${rObj.type==='rien'?'selected':''}>😢 Perdant (Merci de votre fidélité)</option>
                    </select> 
                    <input type="number" id="modal-roue-prob" placeholder="Probabilité en % (total doit être 100%)" step="0.1" min="0" max="100" value="${rObj.probabilite}">
                    <div class="info-message" style="margin-top:10px;"><i class="fas fa-info-circle"></i> La somme des probabilités doit être égale à 100%</div>`; break; } if(html){ champs.innerHTML=html; modal.classList.add('active'); } }
        function fermerModal(){ document.getElementById('modal-admin').classList.remove('active'); }
        function sauvegarderModal(){ if(!assertAdminSession()) return; const nom=document.getElementById('modal-nom')?.value; switch(modalType){ case 'portefeuille': if(!nom){ alert('Nom requis'); return; } const reponse=document.getElementById('modal-reponse')?.value||''; const message=document.getElementById('modal-message')?.value||''; const reseau=document.getElementById('modal-reseau')?.value||''; const liaisonRequise = document.getElementById('modal-liaison-requise')?.checked || false; if(modalMode==='ajout') donnees.portefeuilles.push({nom,reponse,messageConfirmation:message,reseau,liaisonRequise}); else donnees.portefeuilles[modalIndex]={...donnees.portefeuilles[modalIndex],nom,reponse,messageConfirmation:message,reseau,liaisonRequise}; database.ref('donnees/portefeuilles').set(donnees.portefeuilles); break; case 'operateur': if(!nom){ alert('Nom requis'); return; } const msg=document.getElementById('modal-message')?.value||''; if(modalMode==='ajout') donnees.operateurs.push({nom,messageConfirmation:msg}); else donnees.operateurs[modalIndex]={...donnees.operateurs[modalIndex],nom,messageConfirmation:msg}; database.ref('donnees/operateurs').set(donnees.operateurs); break; case 'reseau': if(!nom){ alert('Nom requis'); return; } const crypto=document.getElementById('modal-crypto')?.value; const frais=parseFloat(document.getElementById('modal-frais-reseau')?.value)||0; if(modalMode==='ajout'){ if(!donnees.reseaux) donnees.reseaux=[]; donnees.reseaux.push({nom,crypto,fraisReseau:frais}); } else donnees.reseaux[modalIndex]={...donnees.reseaux[modalIndex],nom,crypto,fraisReseau:frais}; database.ref('donnees/reseaux').set(donnees.reseaux); break; case 'crypto': if(!nom){ alert('Nom requis'); return; } if(modalMode==='ajout'){ if(!donnees.cryptos.includes(nom)){ donnees.cryptos.push(nom); if(!donnees.taux[nom]) donnees.taux[nom]={prixUSD:nom==='USDT'?1:0,prixMGA:nom==='USDT'?donnees.usdMGA:0,variation:"0",couleur:"positive",source:'manual'}; } } else{ const ancien=donnees.cryptos[modalIndex]; if(ancien!==nom&&donnees.taux[ancien]){ donnees.taux[nom]=donnees.taux[ancien]; delete donnees.taux[ancien]; } donnees.cryptos[modalIndex]=nom; } database.ref('donnees/cryptos').set(donnees.cryptos); database.ref('donnees/taux').set(donnees.taux); break; case 'taux': const c=document.getElementById('modal-crypto')?.value; if(c){ const pu=parseFloat(document.getElementById('modal-prix-usd')?.value)||0; const pm=parseFloat(document.getElementById('modal-prix-mga')?.value)||0; donnees.taux[c]={prixUSD:pu,prixMGA:pm,variation:document.getElementById('modal-variation')?.value||"0",couleur:document.getElementById('modal-couleur')?.value||"positive",lastUpdate:new Date().toISOString(),source:'manual'}; if(donnees.tauxMode==='auto') setTauxMode('manual'); database.ref('donnees/taux').set(donnees.taux); } break; case 'roue': const nomR=document.getElementById('modal-roue-nom')?.value; if(!nomR){ alert('Nom du lot requis'); return; } const typeR=document.getElementById('modal-roue-type')?.value; const probR=parseFloat(document.getElementById('modal-roue-prob')?.value)||0; if(probR < 0 || probR > 100){ alert('La probabilité doit être entre 0 et 100'); return; } let trRoue = Array.isArray(donnees.roue) ? donnees.roue : (typeof donnees.roue === 'object' && donnees.roue !== null ? Object.values(donnees.roue) : []); donnees.roue = trRoue.filter(item => item !== null); if(!donnees.roue) donnees.roue=[]; if(modalMode==='ajout') donnees.roue.push({id:'ROUE-'+Date.now()+'-'+Math.random().toString(36).substr(2,4), nom:nomR, type:typeR, probabilite:probR}); else donnees.roue[modalIndex]={...donnees.roue[modalIndex], nom:nomR, type:typeR, probabilite:probR}; database.ref('donnees/roue').set(donnees.roue); break; } fermerModal(); afficherTout(); }
        
        function setTauxMode(mode) { if(!assertAdminSession()) return; donnees.tauxMode=mode; document.getElementById('mode-auto').classList.toggle('active',mode==='auto'); document.getElementById('mode-manual').classList.toggle('active',mode==='manual'); database.ref('donnees/tauxMode').set(mode); if(mode==='auto') syncBinance(); }
        function mettreAJourTauxUSD() { if(!assertAdminSession()) return; const v=parseFloat(document.getElementById('usd-mga-input').value); if(isNaN(v)||v<1000||v>10000){ alert('Taux valide 1000-10000'); return; } donnees.usdMGA=v; tauxUSD_MGA=v; document.getElementById('usd-mga-display').textContent=v.toLocaleString(); document.getElementById('usd-mga-lastupdate').innerHTML='Dernière mise à jour: '+new Date().toLocaleTimeString()+' (manuel)'; document.getElementById('usd-mga-input').value=''; database.ref('donnees/usdMGA').set(v); if(donnees.tauxMode==='manual'){ Object.keys(donnees.taux||{}).forEach(c=>{ if(donnees.taux[c]&&donnees.taux[c].prixUSD) donnees.taux[c].prixMGA=Math.round(donnees.taux[c].prixUSD*v); }); database.ref('donnees/taux').set(donnees.taux); afficherTauxSimplifies(); } }
        async function syncTauxUSD() { await getTauxMGA(); alert(`✅ Taux USD/MGA: ${tauxUSD_MGA.toLocaleString()} Ar`); }
        async function getTauxMGA() { try{ const r=await fetch('https://api.exchangerate-api.com/v4/latest/USD'); const d=await r.json(); if(d.rates&&d.rates.MGA){ tauxUSD_MGA=d.rates.MGA; return tauxUSD_MGA; } }catch(e){} return donnees.usdMGA||4700; }
        async function syncBinance() { try{ const [tauxSnap, usdSnap] = await Promise.all([database.ref('donnees/taux').once('value'), database.ref('donnees/usdMGA').once('value')]); if(tauxSnap.val()) donnees.taux=tauxSnap.val(); if(usdSnap.val()) { donnees.usdMGA=usdSnap.val(); tauxUSD_MGA=usdSnap.val(); } document.getElementById('sync-badge').textContent='Actif (30min)'; document.getElementById('sync-badge').style.background='var(--success)'; afficherTauxSimplifies(); dernierSyncTaux=Date.now(); const lastUpdateSpan=document.getElementById('usd-mga-lastupdate'); if(lastUpdateSpan) lastUpdateSpan.innerHTML=`Dernière mise à jour: ${new Date().toLocaleTimeString()} (serveur)`; } catch(e){ console.error(e); document.getElementById('sync-badge').textContent='Erreur'; document.getElementById('sync-badge').style.background='var(--danger)'; } }
        async function syncBinanceManuel() { if(!rateLimiter.peutExecuter()) { alert('Veuillez attendre un moment avant de rafraîchir à nouveau'); return; } alert('🔄 Synchronisation manuelle des taux en cours...'); await callCloudFunction('syncRates'); await syncBinance(); alert('✅ Taux mis à jour !'); }
        function demarrerSyncBinance() { if(binanceInterval) clearInterval(binanceInterval); syncBinance(); binanceInterval = setInterval(syncBinance, 1800000); let tempsRestantSync = 30; setInterval(() => { tempsRestantSync--; if(tempsRestantSync < 0) tempsRestantSync = 30; const syncElement = document.getElementById('next-sync'); if(syncElement) syncElement.textContent = `${tempsRestantSync}m`; }, 60000); }
        
        function modifierFrais(type){ if(!assertAdminSession()) return; const v=parseFloat(document.getElementById(`frais-${type}-input`).value); if(isNaN(v)||v<0||v>100){ alert('Pourcentage valide (0-100)'); return; } donnees.frais[type]=v; database.ref(`donnees/frais/${type}`).set(v); document.getElementById(`frais-${type}-display`).textContent=v+'%'; document.getElementById(`frais-${type}-input`).value=''; alert(`✅ Frais ${type} modifié à ${v}%`); }
        function togglePause(type){ if(!assertAdminSession()) return; if(!donnees.pause) donnees.pause={achat:false,vente:false}; donnees.pause[type]=!donnees.pause[type]; database.ref('donnees/pause').set(donnees.pause); mettreAJourPauseUI(); alert(`✅ Section ${type.toUpperCase()} ${donnees.pause[type]?'EN PAUSE':'ACTIVÉE'}`); }
        function mettreAJourPauseUI(){ const a=document.getElementById('achat-status-text'); const v=document.getElementById('vente-status-text'); const ba=document.getElementById('btn-pause-achat'); const bv=document.getElementById('btn-pause-vente'); if(a){ if(donnees.pause?.achat){ a.innerHTML='Actuellement: <span style="color: var(--danger);">EN PAUSE</span>'; ba.innerHTML='<i class="fas fa-play"></i> ACTIVER'; ba.className='btn btn-play'; } else{ a.innerHTML='Actuellement: <span style="color: var(--success);">Actif</span>'; ba.innerHTML='<i class="fas fa-pause"></i> Mettre en PAUSE'; ba.className='btn btn-pause'; } } if(v){ if(donnees.pause?.vente){ v.innerHTML='Actuellement: <span style="color: var(--danger);">EN PAUSE</span>'; bv.innerHTML='<i class="fas fa-play"></i> ACTIVER'; bv.className='btn btn-play'; } else{ v.innerHTML='Actuellement: <span style="color: var(--success);">Actif</span>'; bv.innerHTML='<i class="fas fa-pause"></i> Mettre en PAUSE'; bv.className='btn btn-pause'; } } }
        function mettreAJourAffichageLimites(){ if(donnees.limites){ document.getElementById('config-min-achat').value=donnees.limites.minAchat||2000; document.getElementById('config-min-achat-trx').value=donnees.limites.minAchatTRX||5000; document.getElementById('config-max-achat').value=donnees.limites.maxAchat||100000; document.getElementById('config-min-vente').value=donnees.limites.minVente||2000; document.getElementById('config-max-vente').value=donnees.limites.maxVente||100000; } if(donnees.messagesSpeciaux) document.getElementById('config-message-trx').value=donnees.messagesSpeciaux.trx||"Frais réseau TRC20 : 3% ou -1 TRX si activation"; }
        function sauvegarderLimites(){ if(!assertAdminSession()) return; donnees.limites={minAchat:parseInt(document.getElementById('config-min-achat').value)||2000,minAchatTRX:parseInt(document.getElementById('config-min-achat-trx').value)||5000,maxAchat:parseInt(document.getElementById('config-max-achat').value)||100000,minVente:parseInt(document.getElementById('config-min-vente').value)||2000,maxVente:parseInt(document.getElementById('config-max-vente').value)||100000}; database.ref('donnees/limites').set(donnees.limites); alert('✅ Limites sauvegardées'); }
        function sauvegarderMessagesSpeciaux(){ if(!assertAdminSession()) return; if(!donnees.messagesSpeciaux) donnees.messagesSpeciaux={}; donnees.messagesSpeciaux.trx=document.getElementById('config-message-trx').value; database.ref('donnees/messagesSpeciaux').set(donnees.messagesSpeciaux); alert('✅ Message spécial sauvegardé'); }
        function verifierConnexionFirebase(){ database.ref('.info/connected').once('value').then(s=>alert(s.val()?'✅ Connecté à Firebase':'❌ Déconnecté')).catch(e=>alert('❌ Erreur: '+e.message)); }
        function forcerChargementDemandes() { database.ref('donnees/demandes').once('value').then(async (snapshot) => { const demandes = snapshot.val(); if(demandes) { donnees.demandes = demandes; const demandesArray = getDemandesTableau(); sauvegarderDemandes(demandesArray); afficherDemandes(); alert(`✅ ${demandesArray.length} demande(s) chargée(s)`); } else { alert('❌ Aucune demande trouvée dans Firebase'); } }).catch(err => { console.error('Erreur:', err); alert('Erreur de chargement: ' + err.message); }); }
        
        class RateLimiter { constructor(limite = 15, fenetre = 60000) { this.limite = limite; this.fenetre = fenetre; this.requetes = []; } peutExecuter() { const maintenant = Date.now(); this.requetes = this.requetes.filter(t => t > maintenant - this.fenetre); if(this.requetes.length >= this.limite) return false; this.requetes.push(maintenant); return true; } }
        const rateLimiter = new RateLimiter(15, 60000);
        let transactionSelectionneeId = null;
        
        function demarrerRafraichissementUtilisateurs() { setInterval(rafraichirUtilisateurs, 120000); rafraichirUtilisateurs(); }
        
        async function loginAdmin() {
            const email = document.getElementById('admin-email').value.trim().toLowerCase();
            const password = document.getElementById('admin-password').value;
            document.getElementById('admin-error').style.display = 'none';
            try {
                await auth.setPersistence(authPersistence.SESSION);
                const userCredential = await auth.signInWithEmailAndPassword(email, password);
                if (!isAuthorizedAdmin(userCredential.user)) { await auth.signOut(); throw new Error('Email non autorisé'); }
            } catch (error) { document.getElementById('admin-error').style.display = 'block'; document.getElementById('admin-error').innerHTML = '<i class="fas fa-exclamation-triangle"></i> ' + error.message; }
        }
        function logoutAdmin() { auth.signOut(); }
        
        auth.onAuthStateChanged((user) => {
            if (isAuthorizedAdmin(user)) {
                document.getElementById('login-page').style.display = 'none';
                document.getElementById('admin-interface').style.display = 'block';
                chargerDonnees();
                demarrerSyncBinance();
                demarrerSurveillanceTransactions();
                verifierPermissionNotification();
                demarrerRafraichissementUtilisateurs();
            } else if (user) {
                auth.signOut();
            } else if (document.getElementById('admin-interface').style.display === 'block') {
                document.getElementById('login-page').style.display = 'flex';
                document.getElementById('admin-interface').style.display = 'none';
            }
        });
        
        window.addEventListener('load',function(){ console.log('🚀 ADMIN PRO - Version optimisée - Cache activé - Téléchargements réduits'); });
