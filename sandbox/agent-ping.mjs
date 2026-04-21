import fetch from 'node-fetch';

async function run() {
  console.log("Logging into app.corgtex.com...");
  const res = await fetch("https://app.corgtex.com/api/auth/callback/credentials", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      email: "system+corgtex@corgtex.local",
      password: "corgtex-test-agent-pw",
      callbackUrl: "/"
    })
  });

  console.log("Login Status:", res.status);
  const cookie = res.headers.raw()['set-cookie'] || [];
  const sessionCookie = cookie.find(c => c.includes('authjs.session-token') || c.includes('next-auth.session-token'));
  
  if (!sessionCookie) {
    console.log("Failed to obtain session cookie. Cannot proceed with E2E URL test.");
    return;
  }

  const authHeader = {
    "Cookie": sessionCookie,
    "User-Agent": "Corgtex E2E Script"
  };

  const urls = [
    "/workspaces",
    "/api/workspaces"
  ];

  for (const url of urls) {
    const response = await fetch(`https://app.corgtex.com${url}`, { headers: authHeader });
    console.log(`[GET] ${url} -> ${response.status}`);
  }
}

run().catch(console.error);
