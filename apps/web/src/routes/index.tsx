import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { env } from "@fightclaw/env/web";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

const TITLE_TEXT = `
 ██████╗ ███████╗████████╗████████╗███████╗██████╗
 ██╔══██╗██╔════╝╚══██╔══╝╚══██╔══╝██╔════╝██╔══██╗
 ██████╔╝█████╗     ██║      ██║   █████╗  ██████╔╝
 ██╔══██╗██╔══╝     ██║      ██║   ██╔══╝  ██╔══██╗
 ██████╔╝███████╗   ██║      ██║   ███████╗██║  ██║
 ╚═════╝ ╚══════╝   ╚═╝      ╚═╝   ╚══════╝╚═╝  ╚═╝

 ████████╗    ███████╗████████╗ █████╗  ██████╗██╗  ██╗
 ╚══██╔══╝    ██╔════╝╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝
    ██║       ███████╗   ██║   ███████║██║     █████╔╝
    ██║       ╚════██║   ██║   ██╔══██║██║     ██╔═██╗
    ██║       ███████║   ██║   ██║  ██║╚██████╗██║  ██╗
    ╚═╝       ╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝
 `;

function HomeComponent() {
  const [authToken, setAuthToken] = useState("");
  const [matchId, setMatchId] = useState<string | null>(null);
  const [stateVersion, setStateVersion] = useState(0);
  const [response, setResponse] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem("fightclaw.devAgentKey");
    if (stored) setAuthToken(stored);
  }, []);

  useEffect(() => {
    if (!authToken) return;
    window.localStorage.setItem("fightclaw.devAgentKey", authToken);
  }, [authToken]);

  const queueMatch = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${env.VITE_SERVER_URL}/v1/matches/queue`, {
        method: "POST",
      });
      const json = (await res.json()) as { matchId?: string };
      if (json.matchId) {
        setMatchId(json.matchId);
        setStateVersion(0);
      }
      setResponse(json);
    } catch (error) {
      setResponse({ error: (error as Error).message ?? "Queue failed." });
    } finally {
      setBusy(false);
    }
  };

  const submitDummyMove = async () => {
    if (!matchId) {
      setResponse({ error: "Queue a match first." });
      return;
    }
    if (!authToken) {
      setResponse({ error: "Set DEV agent key first." });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${env.VITE_SERVER_URL}/v1/matches/${matchId}/move`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          moveId: crypto.randomUUID(),
          expectedVersion: stateVersion,
          move: { action: "ping", at: new Date().toISOString() },
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        state?: { stateVersion?: number };
        stateVersion?: number;
      };
      if (json.ok && json.state?.stateVersion !== undefined) {
        setStateVersion(json.state.stateVersion);
      }
      if (!json.ok && json.stateVersion !== undefined) {
        setStateVersion(json.stateVersion);
      }
      setResponse(json);
    } catch (error) {
      setResponse({ error: (error as Error).message ?? "Move failed." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container mx-auto max-w-3xl px-4 py-2">
      <pre className="overflow-x-auto font-mono text-sm">{TITLE_TEXT}</pre>
      <div className="grid gap-6">
        <section className="rounded-lg border p-4">
          <h2 className="mb-2 font-medium">API Status</h2>
        </section>
        <section className="grid gap-4 rounded-lg border p-4">
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="dev-agent-key">
              DEV Agent Key
            </label>
            <Input
              id="dev-agent-key"
              placeholder="Paste DEV_AGENT_KEY"
              value={authToken}
              onChange={(event) => setAuthToken(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={queueMatch} disabled={busy}>
              Queue Match
            </Button>
            <Button type="button" variant="secondary" onClick={submitDummyMove} disabled={busy}>
              Submit Dummy Move
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            Match: {matchId ?? "—"} · stateVersion: {stateVersion}
          </div>
          <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">
            {response ? JSON.stringify(response, null, 2) : "No response yet."}
          </pre>
        </section>
      </div>
    </div>
  );
}
