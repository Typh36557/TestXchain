const admin = require('firebase-admin');

if (!admin.apps.length) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const projectId = process.env.FIREBASE_PROJECT_ID;

    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: projectId,
            clientEmail: clientEmail,
            privateKey: privateKey
        }),
        databaseURL: `https://${projectId}.firebaseio.com`
    });
}

const db = admin.database();

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method === 'POST' && req.url === '/api/ajouter') {
        try {
            const { message } = req.body;
            
            if (!message || message.length > 500) {
                return res.status(400).json({ error: 'Message invalide' });
            }
            
            const ref = db.ref('messages');
            await ref.push({
                texte: message,
                date: new Date().toISOString()
            });
            
            return res.json({ success: true });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    return res.status(404).json({ error: 'Route non trouvée' });
};