import express from "express";
import { createServer } from "http";
import { createServer as createHttpsServer } from "https";
import { readFileSync, existsSync } from "fs";
import { WebSocketServer } from "ws";
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { randomUUID } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

const PORT = process.env.PORT || 3001;
const REGION = process.env.AWS_REGION || "ap-northeast-1";
const MODEL_ID = "amazon.nova-sonic-v1:0";
const DDB_TABLE = process.env.DDB_TABLE || "nova-sonic-sessions";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS: allow the Amplify-hosted frontends (any *.amplifyapp.com) and local dev
app.use((req, res, next) => {
  const origin = req.headers.origin;
  let allow = false;
  if (origin) {
    try {
      const host = new URL(origin).hostname;
      allow = /\.amplifyapp\.com$/i.test(host) || origin === "http://localhost:5173";
    } catch {}
  }
  if (allow) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Use HTTPS if certs exist, otherwise HTTP
const certPath = "/etc/ssl/nova-sonic";
let server;
if (existsSync(`${certPath}/cert.pem`) && existsSync(`${certPath}/key.pem`)) {
  server = createHttpsServer(
    {
      cert: readFileSync(`${certPath}/cert.pem`),
      key: readFileSync(`${certPath}/key.pem`),
    },
    app
  );
  console.log("Using HTTPS");
} else {
  server = createServer(app);
  console.log("Using HTTP (no certs found)");
}

const wss = new WebSocketServer({ server });

app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- Chat session persistence (DynamoDB) ----
// Table: PK userId (S), SK sessionId (S). Responses expose sessionId as `id`.
function toSummary(item) {
  return {
    id: item.sessionId,
    title: item.title,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// List a user's sessions (no message bodies)
app.get("/api/sessions", async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    const out = await ddb.send(
      new QueryCommand({
        TableName: DDB_TABLE,
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": String(userId) },
      })
    );
    const sessions = (out.Items || [])
      .map(toSummary)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    res.json({ sessions });
  } catch (err) {
    console.error("list sessions error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Create a session
app.post("/api/sessions", async (req, res) => {
  const { userId, title } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  const now = new Date().toISOString();
  const item = {
    userId: String(userId),
    sessionId: randomUUID(),
    title: title || "New chat",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  try {
    await ddb.send(new PutCommand({ TableName: DDB_TABLE, Item: item }));
    res.json({ ...toSummary(item), messages: [] });
  } catch (err) {
    console.error("create session error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get a session with its messages
app.get("/api/sessions/:sessionId", async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    const out = await ddb.send(
      new GetCommand({
        TableName: DDB_TABLE,
        Key: { userId: String(userId), sessionId: req.params.sessionId },
      })
    );
    if (!out.Item) return res.status(404).json({ error: "not found" });
    res.json({ ...toSummary(out.Item), messages: out.Item.messages || [] });
  } catch (err) {
    console.error("get session error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Append messages and/or rename
app.patch("/api/sessions/:sessionId", async (req, res) => {
  const { userId, appendMessages, title } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  const now = new Date().toISOString();
  const sets = ["updatedAt = :now"];
  const names = {};
  const values = { ":now": now };
  if (Array.isArray(appendMessages) && appendMessages.length) {
    sets.push("messages = list_append(if_not_exists(messages, :empty), :m)");
    values[":empty"] = [];
    values[":m"] = appendMessages;
  }
  if (typeof title === "string" && title.length) {
    sets.push("#t = :title");
    names["#t"] = "title";
    values[":title"] = title;
  }
  try {
    const out = await ddb.send(
      new UpdateCommand({
        TableName: DDB_TABLE,
        Key: { userId: String(userId), sessionId: req.params.sessionId },
        UpdateExpression: "SET " + sets.join(", "),
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(sessionId)",
        ReturnValues: "ALL_NEW",
      })
    );
    const item = out.Attributes || {};
    res.json({ ...toSummary(item), messages: item.messages || [] });
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException")
      return res.status(404).json({ error: "not found" });
    console.error("patch session error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a session
app.delete("/api/sessions/:sessionId", async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: DDB_TABLE,
        Key: { userId: String(userId), sessionId: req.params.sessionId },
      })
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("delete session error:", err);
    res.status(500).json({ error: err.message });
  }
});

wss.on("connection", (ws) => {
  console.log("Client connected");
  let isActive = false;
  let inputResolve = null;
  const inputQueue = [];

  const promptName = randomUUID();
  const contentName = randomUUID();
  const audioContentName = randomUUID();

  const client = new BedrockRuntimeClient({ region: REGION });

  // Create an async iterable that yields events to Bedrock
  async function* createInputStream() {
    // Yield setup events first
    for (const event of getSetupEvents()) {
      yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(event)) } };
    }

    // Then yield audio chunks as they come from the WebSocket
    while (isActive) {
      const data = await waitForInput();
      if (data === null) break; // signal to stop
      yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(data)) } };
    }
  }

  function waitForInput() {
    if (inputQueue.length > 0) {
      return Promise.resolve(inputQueue.shift());
    }
    return new Promise((resolve) => {
      inputResolve = resolve;
    });
  }

  function pushInput(data) {
    if (inputResolve) {
      const resolve = inputResolve;
      inputResolve = null;
      resolve(data);
    } else {
      inputQueue.push(data);
    }
  }

  function getSetupEvents() {
    return [
      {
        event: {
          sessionStart: {
            inferenceConfiguration: {
              maxTokens: 1024,
              topP: 0.9,
              temperature: 0.7,
            },
          },
        },
      },
      {
        event: {
          promptStart: {
            promptName,
            textOutputConfiguration: { mediaType: "text/plain" },
            audioOutputConfiguration: {
              mediaType: "audio/lpcm",
              sampleRateHertz: 24000,
              sampleSizeBits: 16,
              channelCount: 1,
              voiceId: "tiffany",
              encoding: "base64",
              audioType: "SPEECH",
            },
          },
        },
      },
      // System prompt content start
      {
        event: {
          contentStart: {
            promptName,
            contentName,
            type: "TEXT",
            interactive: true,
            role: "SYSTEM",
            textInputConfiguration: { mediaType: "text/plain" },
          },
        },
      },
      {
        event: {
          textInput: {
            promptName,
            contentName,
            content:
              "You are a friendly assistant. The user and you will engage in a spoken dialog. Keep your responses short, generally two or three sentences.",
          },
        },
      },
      {
        event: { contentEnd: { promptName, contentName } },
      },
      // Audio input content start
      {
        event: {
          contentStart: {
            promptName,
            contentName: audioContentName,
            type: "AUDIO",
            interactive: true,
            role: "USER",
            audioInputConfiguration: {
              mediaType: "audio/lpcm",
              sampleRateHertz: 16000,
              sampleSizeBits: 16,
              channelCount: 1,
              audioType: "SPEECH",
              encoding: "base64",
            },
          },
        },
      },
    ];
  }

  async function startSession() {
    try {
      isActive = true;
      console.log("Starting Bedrock session with model:", MODEL_ID, "region:", REGION);

      const command = new InvokeModelWithBidirectionalStreamCommand({
        modelId: MODEL_ID,
        body: createInputStream(),
      });

      console.log("Sending command to Bedrock...");
      const response = await client.send(command);
      console.log("Bedrock session established");

      ws.send(JSON.stringify({ type: "session_started" }));

      // Process output stream
      processResponses(response.body);
    } catch (err) {
      console.error("Failed to start session:", err.name, err.message);
      console.error("Full error:", JSON.stringify(err, null, 2));
      try {
        ws.send(JSON.stringify({ type: "error", message: err.message }));
      } catch {}
      isActive = false;
    }
  }

  async function processResponses(outputStream) {
    let currentRole = null;
    let isSpeculative = false;

    try {
      for await (const event of outputStream) {
        if (!isActive) break;

        if (event.chunk?.bytes) {
          const data = JSON.parse(new TextDecoder().decode(event.chunk.bytes));

          if (data.event) {
            if (data.event.contentStart) {
              const cs = data.event.contentStart;
              currentRole = cs.role;
              isSpeculative = false;
              if (cs.additionalModelFields) {
                try {
                  const af = JSON.parse(cs.additionalModelFields);
                  isSpeculative = af.generationStage === "SPECULATIVE";
                } catch {}
              }
              ws.send(
                JSON.stringify({
                  type: "content_start",
                  role: currentRole,
                  speculative: isSpeculative,
                })
              );
            } else if (data.event.textOutput) {
              ws.send(
                JSON.stringify({
                  type: "text",
                  content: data.event.textOutput.content,
                  role: currentRole,
                  speculative: isSpeculative,
                })
              );
            } else if (data.event.audioOutput) {
              ws.send(
                JSON.stringify({
                  type: "audio",
                  content: data.event.audioOutput.content,
                })
              );
            } else if (data.event.contentEnd) {
              ws.send(JSON.stringify({ type: "content_end" }));
              currentRole = null;
              isSpeculative = false;
            }
          }
        }
      }
    } catch (err) {
      if (isActive) {
        console.error("Response processing error:", err);
        ws.send(JSON.stringify({ type: "error", message: err.message }));
      }
    }
  }

  async function endSession() {
    if (!isActive) return;
    isActive = false;

    // Send closing events through the input stream
    pushInput({
      event: { contentEnd: { promptName, contentName: audioContentName } },
    });
    pushInput({
      event: { promptEnd: { promptName } },
    });
    pushInput({
      event: { sessionEnd: {} },
    });
    // Signal the generator to stop
    pushInput(null);
  }

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw);
      console.log("Received message:", msg.type);
      if (msg.type === "start_session") {
        await startSession();
      } else if (msg.type === "audio_chunk" && isActive) {
        pushInput({
          event: {
            audioInput: {
              promptName,
              contentName: audioContentName,
              content: msg.content,
            },
          },
        });
      } else if (msg.type === "end_session") {
        await endSession();
        ws.send(JSON.stringify({ type: "session_ended" }));
      }
    } catch (err) {
      console.error("Message handling error:", err);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    endSession();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
