function safeJsonParse(value: string, fallback: any) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function slackRequest<T>(
  accessToken: string,
  url: string,
  init?: RequestInit,
) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  const data = text ? safeJsonParse(text, {}) : {};

  if (!res.ok || data?.ok === false) {
    if (data?.error === "invalid_channel") {
      throw new Error("Slack channel not found or bot is not in the channel");
    }
    if (data?.error === "channel_not_found") {
      throw new Error("Slack channel not found or bot is not in the channel");
    }
    const message = data?.error || `Slack API error ${res.status}`;
    throw new Error(message);
  }

  return data as T;
}

export async function slackPostMessage(
  accessToken: string,
  channel: string,
  text: string,
) {
  const normalizedChannel = channel.trim().replace(/^#/, "");
  const data = await slackRequest<any>(
    accessToken,
    "https://slack.com/api/chat.postMessage",
    {
      method: "POST",
      body: JSON.stringify({ channel: normalizedChannel, text }),
    },
  );

  return {
    ok: true,
    channel: data.channel,
    ts: data.ts,
    message: data.message?.text || text,
  };
}

export async function slackLookupUserByEmail(
  accessToken: string,
  email: string,
) {
  const data = await slackRequest<any>(
    accessToken,
    `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
    { method: "GET" },
  );

  return {
    id: data.user?.id as string | undefined,
    name: data.user?.name as string | undefined,
  };
}

export async function slackOpenDm(accessToken: string, userId: string) {
  const data = await slackRequest<any>(
    accessToken,
    "https://slack.com/api/conversations.open",
    {
      method: "POST",
      body: JSON.stringify({ users: userId }),
    },
  );

  return data.channel?.id as string | undefined;
}
