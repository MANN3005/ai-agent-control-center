import OpenAI from "openai";
import { requireEnv } from "../config";

let groqClient: OpenAI | null = null;

export function getGroqClient() {
  if (groqClient) return groqClient;
  const apiKey = requireEnv("GROQ_API_KEY");
  groqClient = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });
  return groqClient;
}
