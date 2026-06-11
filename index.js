const express = require('express');
const { MongoClient } = require('mongodb');
const zlib = require('zlib'); // Import the built-in decompression module

const app = express();

// Force Express to read everything as raw unfiltered text
app.use((req, res, next) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
        req.body = data;
        next();
    });
});

const mongoUri = process.env.MONGO_URI;
if (!mongoUri) {
    console.error("CRITICAL ERROR: MONGO_URI environment variable is missing!");
    process.exit(1);
}

const client = new MongoClient(mongoUri);
let db, savesCollection;

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

app.post('/', async (req, res) => {
    const action = req.headers['action'];
    const containerRaw = req.headers['container'];

    // 1. Handle Ping Action
    if (action === 'ping') {
        return res.status(200).send(JSON.stringify({ response: true, message: "pong" }));
    }

    if (!containerRaw) {
        return res.status(400).send("Missing container header");
    }
    
    let userId;
    try {
        if (containerRaw.startsWith("{")) {
            userId = JSON.parse(containerRaw).user;
        } else {
            // Decode Base64, then inflate the Zlib compressed buffer
            const compressedBuffer = Buffer.from(containerRaw, 'base64');
            let decompressed;
            try {
                decompressed = zlib.inflateSync(compressedBuffer).toString('utf8');
            } catch (err) {
                // Fallback to raw inflate if the standard Zlib header is missing
                decompressed = zlib.inflateRawSync(compressedBuffer).toString('utf8');
            }
            userId = JSON.parse(decompressed).user;
        }
    } catch(e) {
        console.error("Container parsing error:", e);
        return res.status(400).send("Invalid container data structure");
    }

    userId = String(userId);

    // 2. Handle Get (Load Data) Action
    if (action === 'get') {
        try {
            const playerData = await savesCollection.findOne({ _id: userId });
            if (playerData && playerData.encodedSave) {
                return res.status(200).send(JSON.stringify({ response: true, data: playerData.encodedSave }));
            } else {
                return res.status(200).send(JSON.stringify({ response: false }));
            }
        } catch (error) {
            console.error("Database read failed:", error);
            return res.status(500).send(JSON.stringify({ response: false, error: "Internal read error" }));
        }
    }

    // 3. Handle Save Data Action
    if (action === 'save') {
        let encodedSaveData = req.body;
        
        if (!encodedSaveData || encodedSaveData.trim() === "") {
            console.error("Save failed: Payload body was empty!");
            return res.status(400).send("Empty payload body");
        }

        // Clean extra escaping JSON quotes injected by your Luau script
        if (encodedSaveData.startsWith('"') && encodedSaveData.endsWith('"')) {
            try {
                encodedSaveData = JSON.parse(encodedSaveData);
            } catch (e) {
                encodedSaveData = encodedSaveData.slice(1, -1);
            }
        }

        try {
            await savesCollection.updateOne(
                { _id: userId },
                { $set: { encodedSave: encodedSaveData, updatedAt: new Date() } },
                { upsert: true }
            );
            console.log(`Successfully saved data document for user: ${userId}`);
            return res.status(200).send(JSON.stringify({ response: true }));
        } catch (error) {
            console.error("Database update failed:", error);
            return res.status(500).send(JSON.stringify({ response: false, error: "Internal save error" }));
        }
    }

    return res.status(400).send("Unknown action value passed");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Roblox Database Bridge running on port ${PORT}`));
