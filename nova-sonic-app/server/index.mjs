import express from "express";
import { createServer } from "http";
import { createServer as createHttpsServer } from "https";
import { readFileSync, existsSync } from "fs";
import { WebSocketServer } from "ws";
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  InvokeModelCommand,
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

  // Conversation history for feedback generation
  const conversationHistory = [];

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
              "You are an experienced English conversation teacher specializing in technical English for cloud engineers. " +
              "Your student is an AWS Support Engineer who handles cases involving Lambda, VPC networking, NAT instances/gateways, " +
              "EC2 connectivity, IAM permissions, S3 access issues, Route53 DNS resolution, and other AWS services daily. " +
              "At the start, suggest specific technical scenarios to discuss, such as: " +
              "1) Troubleshooting Lambda functions that can't reach the internet from a VPC, " +
              "2) Debugging NAT instance vs NAT gateway connectivity issues, " +
              "3) Explaining VPC peering or Transit Gateway setups to a customer, " +
              "4) Walking a customer through IAM policy evaluation logic, " +
              "5) Handling a Sev-2 outage call with a customer. " +
              "Ask the student to pick one or suggest their own. " +
              "During the conversation, actively drive the discussion with follow-up questions and realistic scenarios. " +
              "For example, if discussing Lambda VPC networking, ask things like 'So the customer says their Lambda function times out " +
              "when calling an external API. What would you check first?' " +
              "If the student makes a grammar mistake or could use a better expression, " +
              "briefly point it out like: 'Quick note - you said X, but Y sounds more natural.' " +
              "Then immediately continue the technical discussion. Never let corrections derail the conversation. " +
              "Keep responses concise, two to three sentences max.",
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
              const text = data.event.textOutput.content;
              // Accumulate conversation history
              if (currentRole === "USER") {
                conversationHistory.push({ role: "USER", text });
              } else if (currentRole === "ASSISTANT" && isSpeculative) {
                conversationHistory.push({ role: "ASSISTANT", text });
              }
              ws.send(
                JSON.stringify({
                  type: "text",
                  content: text,
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

    // Generate feedback if there's conversation history
    if (conversationHistory.length > 0) {
      try {
        const feedback = await generateFeedback();
        ws.send(JSON.stringify({ type: "feedback", content: feedback }));
      } catch (err) {
        console.error("Feedback generation error:", err);
      }
    }
  }

  async function generateFeedback() {
    const transcript = conversationHistory
      .map((m) => `${m.role}: ${m.text}`)
      .join("\n");

    const prompt = `You are an English language coach reviewing a conversation between an English teacher and a Japanese AWS Support Engineer practicing English.

Here is the conversation transcript:
---
${transcript}
---

Please provide feedback in Japanese with the following sections:
1. 📝 文法の改善点: List specific grammar mistakes the student made, with corrections and explanations.
2. 💬 より自然な表現: Suggest more natural or professional English expressions the student could have used.
3. 🌟 良かった点: Highlight what the student did well.
4. 📚 次回の学習ポイント: Suggest specific areas to focus on next time.

Keep the feedback concise and actionable.`;

    const command = new InvokeModelCommand({
      modelId: "amazon.nova-lite-v1:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        messages: [{ role: "user", content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 1024, temperature: 0.7 },
      }),
    });

    const response = await client.send(command);
    const result = JSON.parse(new TextDecoder().decode(response.body));
    return result.output.message.content[0].text;
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
