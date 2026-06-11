const express = require('express');
const { MongoClient } = require('mongodb');

const app = express();
// Allows the API to parse raw text payloads up to 10MB (since your Roblox data is zlib/base64 compressed)
app.use(express.text({ limit: '10mb' })); 

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
        // Safe processing of the Roblox container block to isolate the UserId string
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

    // Ensure userId is handled safely as a uniform string layout
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
        const encodedSaveData = req.body; // Raw compressed payload string block from Roblox
        
        if (!encodedSaveData || encodedSaveData.trim() === "") {
            return res.status(400).send("Empty payload body");
        }

        try {
            await savesCollection.updateOne(
                { _id: userId },
                { $set: { encodedSave: encodedSaveData, updatedAt: new Date() } },
                { upsert: true }
            );
            return res.json({ response: true });
        } catch (error) {
            console.error("Database upsert update failed:", error);
            return res.status(500).json({ response: false, error: "Internal save error" });
        }
    }

    return res.status(400).send("Unknown action value passed");
});

// Render configures the PORT variable automatically
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Roblox Database Bridge running on port ${PORT}`));
