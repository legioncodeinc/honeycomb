#!/usr/bin/env node
// Minimal Claude-on-Bedrock caller, authenticated with an Amazon Bedrock API
// key (bearer token). We use AWS's own SDK (@aws-sdk/client-bedrock-runtime),
// which natively detects AWS_BEARER_TOKEN_BEDROCK and sends it as a bearer
// token — no access-key/secret pair and no SigV4. (The Anthropic wrapper SDK's
// auto-detection of this env var was still a tracked gap in late 2025, so we go
// straight to the AWS client for reliability.)
//
// ENV: AWS_BEARER_TOKEN_BEDROCK (the API key), AWS_REGION, BEDROCK_MODEL_ID
//      (the Sonnet 5 cross-region inference-profile id).

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

// Returns the concatenated text of Claude's reply (throws on missing config or
// an API error — callers decide whether that is fatal or fail-soft).
export async function invokeClaude({ system, messages, maxTokens = 512 }) {
  const model = process.env.BEDROCK_MODEL_ID;
  if (!model) {
    throw new Error(
      "BEDROCK_MODEL_ID is required (the Sonnet 5 inference-profile id).",
    );
  }
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
    throw new Error(
      "AWS_BEARER_TOKEN_BEDROCK is required (the Amazon Bedrock API key).",
    );
  }

  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION || "us-east-1",
  });

  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages,
  };

  const res = await client.send(
    new InvokeModelCommand({
      modelId: model,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    }),
  );

  const decoded = JSON.parse(new TextDecoder().decode(res.body));
  return (decoded.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}
