import OpenAI from "openai";
import { requireEnv } from "../config";

let llmClient: OpenAI | null = null;
let llmProvider: "gemini" | "groq" | null = null;

function resolveProvider(): "gemini" | "groq" {
  const explicit = String(process.env.LLM_PROVIDER || "")
    .trim()
    .toLowerCase();
  if (explicit === "groq") return "groq";
  if (explicit === "gemini") return "gemini";

  // Auto-detect when provider isn't explicitly set.
  if (process.env.GROQ_API_KEY) return "groq";
  return "gemini";
}

function createClientForProvider(provider: "gemini" | "groq") {
  if (provider === "groq") {
    return new OpenAI({
      apiKey: requireEnv("GROQ_API_KEY"),
      baseURL: "https://api.groq.com/openai/v1",
    });
  }

  return new OpenAI({
    apiKey: requireEnv("GEMINI_API_KEY"),
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
  });
}

export function getGroqClient() {
  if (!llmClient || llmProvider !== "groq") {
    llmClient = createClientForProvider("groq");
    llmProvider = "groq";
  }
  return llmClient;
}

export function getLlmClient() {
  const provider = resolveProvider();
  if (llmClient && llmProvider === provider) return llmClient;

  llmClient = createClientForProvider(provider);
  llmProvider = provider;
  return llmClient;
}

export function getLlmModel(defaultModel = "gemini-3.1-pro-preview") {
  const provider = resolveProvider();
  if (provider === "groq") {
    return process.env.GROQ_MODEL || process.env.LLM_MODEL || "llama-3.3-70b-versatile";
  }

  return process.env.GEMINI_MODEL || process.env.LLM_MODEL || defaultModel;
}

export async function createJsonObjectCompletion(
  client: OpenAI,
  model: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  temperature = 0.2,
) {
  return client.chat.completions.create({
    model,
    messages,
    response_format: { type: "json_object" },
    temperature,
  });
}

export async function createChatCompletionWithFallback(
  client: OpenAI,
  model: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  temperature = 0.2,
) {
  return client.chat.completions.create({
    model,
    messages,
    temperature,
  });
}
