// ============================================
// CONFIGURATION FIREBASE
// ============================================
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

// ============================================
// CONSTANTES GLOBALES
// ============================================
const pairesBinance = { 
    'USDT':'USDTUSDT','BTC':'BTCUSDT','ETH':'ETHUSDT','BNB':'BNBUSDT','LTC':'LTCUSDT',
    'SOL':'SOLUSDT','TRX':'TRXUSDT','DOGE':'DOGEUSDT','MATIC':'POLUSDT','SUI':'SUIUSDT',
    'XRP':'XRPUSDT','TON':'TONUSDT','POL':'POLUSDT','USDC':'USDCUSDT'
};

const lotsParDefaut = [
    { id: 'L1', nom: '10 $ Gratuit', type: 'crypto', probabilite: 0 },
    { id: 'L2', nom: 'Frais de gaz - 0.00004 BNB', type: 'crypto', probabilite: 10 },
    { id: 'L3', nom: 'Crédit 500 Ar', type: 'fiat', probabilite: 1 },
    { id: 'L4', nom: '0.2 TON', type: 'crypto', probabilite: 2 },
    { id: 'L5', nom: 'Merci de votre fidélité', type: 'rien', probabilite: 87 }
];

// Initialisation Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();
const auth = firebase.auth();