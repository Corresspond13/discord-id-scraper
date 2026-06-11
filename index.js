const express = require('express');
const { MongoClient } = require('mongodb');

const app = express();

// FIXED: Added type: '*/*' to capture the compressed Roblox string block regardless of what Content-Type Roblox sends
app.use(express.text({ type: '*/*', limit: '10mb' })); 

const mongoUri = process.env.MONGO_URI;
if (!mongoUri) {
    console.error("CRITICAL ERROR: MONGO_URI environment variable is missing!");
    process.exit(1);
}

const client = new MongoClient(mongoUri);
let db, savesCollection;

// Connect to MongoDB Atlas
async function connectDB() {
    try {
        await client.connect();
        db = client.db("RobloxGameData");
        savesCollection = db.collection("PlayerSaves");
        console.log("Successfully connected to MongoDB Atlas!");
    } catch (err) {
        console.error("MongoDB connection failed:", err);
    }
}
connectDB();

// Root route handler for Roblox HttpService requests
app.post('/', async (req, res) => {
    const action = req.headers['action'];
    const containerRaw = req.headers['container'];

    // 1. Handle Ping Action (System Check)
    if (action === 'ping') {
        return res.status(200).json({ response: true, message: "pong" });
    }

    // Validation check for Save/Get actions
    if (!containerRaw) {
        return res.status(400).send("Missing container header");
    }
    
    let userId;
    try {
        if (containerRaw.startsWith("{")) {
            userId = JSON.parse(containerRaw).user;
        } else {
            const decoded = Buffer.from(containerRaw, 'base64').toString('utf8');
            const cleanJson = decoded.substring(decoded.indexOf('{'), decoded.lastIndexOf('}') + 1);
            userId = JSON.parse(cleanJson).user;
        }
    } catch(e) {
        return res.status(400).send("Invalid container data structure");
    }

    userId = String(userId);

    // 2. Handle Get (Load Data) Action
    if (action === 'get') {
        try {
            const playerData = await savesCollection.findOne({ _id: userId });
            if (playerData && playerData.encodedSave) {
                return res.json({ response: true, data: playerData.encodedSave });
            } else {
                return res.json({ response: false });
            }
        } catch (error) {
            console.error("Database query read failed:", error);
            return res.status(500).json({ response: false, error: "Internal read error" });
        }
    }

    // 3. Handle Save Data Action
    if (action === 'save') {
        const encodedSaveData = req.body; // Captured raw text payload string block
        
        if (!encodedSaveData || encodedSaveData.trim() === "") {
            console.error("Save failed: Payload body was empty!");
            return res.status(400).send("Empty payload body");
        }

        try {
            await savesCollection.updateOne(
                { _id: userId },
                { $set: { encodedSave: encodedSaveData, updatedAt: new Date() } },
                { upsert: true }
            );
            console.log(`Successfully saved data document for user: ${userId}`);
            return res.json({ response: true });
        } catch (error) {
            console.error("Database upsert update failed:", error);
            return res.status(500).json({ response: false, error: "Internal save error" });
        }
    }

    return res.status(400).send("Unknown action value passed");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Roblox Database Bridge running on port ${PORT}`));
