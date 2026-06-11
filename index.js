const express = require('express');
const { MongoClient } = require('mongodb');
const zlib = require('zlib');

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

// Default safe template to merge into incoming data
const defaultTemplate = {
    shards: 0,
    cash: 0,
    bank: 0,
    level: 1,
    xp: 0,
    reputation: 0,
    attributes: {
        strength: 0,
        endurance: 0,
        agility: 0,
        altruism: 0
    },
    traits: {
        boons: {},
        flaws: {}
    },
    equipped_emotes: {},
    owned_emotes: {},
    skins: []
};

// Helper function to safely backfill any missing data before sending to Roblox
function sanitizeSaveData(rawData) {
    const safeData = { ...defaultTemplate, ...rawData };

    safeData.attributes = {
        ...defaultTemplate.attributes,
        ...(rawData.attributes || {})
    };

    safeData.traits = {
        boons: rawData.traits && rawData.traits.boons ? rawData.traits.boons : {},
        flaws: rawData.traits && rawData.traits.flaws ? rawData.traits.flaws : {},
        ...(rawData.traits || {})
    };

    if (!Array.isArray(safeData.skins)) {
        safeData.skins = [];
    }

    return safeData;
}

// Decompresses, updates missing fields, and re-compresses the save
function processAndSanitizeSave(base64Save) {
    try {
        const compressedBuffer = Buffer.from(base64Save, 'base64');
        let decompressedString;
        try {
            decompressedString = zlib.inflateSync(compressedBuffer).toString('utf8');
        } catch (err) {
            decompressedString = zlib.inflateRawSync(compressedBuffer).toString('utf8');
        }

        const parsedData = JSON.parse(decompressedString);
        const sanitizedData = sanitizeSaveData(parsedData);
        
        const sanitizedJson = JSON.stringify(sanitizedData);
        const recompressedBuffer = zlib.deflateSync(Buffer.from(sanitizedJson, 'utf8'));

        return recompressedBuffer.toString('base64');
    } catch (e) {
        console.error("Pipeline failed to sanitize save, returning original raw payload:", e);
        return base64Save; 
    }
}

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
            const compressedBuffer = Buffer.from(containerRaw, 'base64');
            let decompressed;
            try {
                decompressed = zlib.inflateSync(compressedBuffer).toString('utf8');
            } catch (err) {
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
                // Run the sanitization/backfill process on the saved string before sending it
                const sanitizedSave = processAndSanitizeSave(playerData.encodedSave);
                return res.status(200).send(JSON.stringify({ response: true, data: sanitizedSave }));
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
