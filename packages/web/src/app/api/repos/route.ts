import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import type { EnrichedRepository } from "@open-inspect/shared";

interface ControlPlaneReposResponse {
  repos: EnrichedRepository[];
  cached: boolean;
  cachedAt: string;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    console.warn("[repos] unauthorized repository list request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requester = session.user?.login ?? session.user?.email ?? "unknown";

  console.info("[repos] fetching repositories from control plane", {
    requester,
  });

  try {
    // Fetch repositories from control plane using GitHub App installation token.
    // This ensures we only show repos the App has access to, not all repos the user can see.
    const response = await controlPlaneFetch("/repos");

    console.info("[repos] control plane response received", {
      requester,
      status: response.status,
      ok: response.ok,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("[repos] control plane API error", {
        requester,
        status: response.status,
        error,
      });
      return NextResponse.json(
        { error: "Failed to fetch repositories" },
        { status: response.status }
      );
    }

    const data: ControlPlaneReposResponse = await response.json();

    console.info("[repos] repositories loaded", {
      requester,
      repoCount: data.repos.length,
      cached: data.cached,
      cachedAt: data.cachedAt,
      sampleRepos: data.repos.slice(0, 5).map((repo) => repo.fullName),
    });
    if (data.repos.length === 0) {
      console.warn("[repos] repository list is empty", {
        requester,
        cached: data.cached,
        cachedAt: data.cachedAt,
      });
    }

    // The control plane returns repos in the format we need
    return NextResponse.json({ repos: data.repos });
  } catch (error) {
    console.error("[repos] unexpected error fetching repositories", {
      requester,
      error,
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
