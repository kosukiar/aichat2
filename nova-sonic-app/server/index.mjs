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

const PORT = process.env.PORT || 3001;
const REGION = process.env.AWS_REGION || "ap-northeast-1";
const MODEL_ID = "amazon.nova-sonic-v1:0";

const app = express();

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
              "You are an English conversation teacher. Your student is an AWS Support Engineer. " +
              "At the start of the conversation, suggest a few topics such as technical discussions (e.g. cloud architecture, troubleshooting), " +
              "business conversations (e.g. meetings, presentations), or casual small talk, and ask the student what they'd like to talk about. " +
              "During the conversation, if the student makes a grammar mistake or could use a better English expression, " +
              "gently point it out with a brief correction like: 'By the way, you said X, but you could say Y.' " +
              "However, do NOT let corrections interrupt the flow of conversation. Keep corrections short and light, " +
              "then immediately continue the discussion. Prioritize natural, engaging conversation above all. " +
              "Keep your responses concise, generally two or three sentences.",
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
