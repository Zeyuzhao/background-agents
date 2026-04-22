import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    console.warn("[branches] unauthorized branch list request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { owner, name } = await params;
  const requester = session.user.login ?? session.user.email ?? "unknown";

  console.info("[branches] fetching branches from control plane", {
    requester,
    repo: `${owner}/${name}`,
  });

  try {
    const response = await controlPlaneFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`
    );
    console.info("[branches] control plane response received", {
      requester,
      repo: `${owner}/${name}`,
      status: response.status,
      ok: response.ok,
    });
    const data = await response.json();
    if (response.ok) {
      const branches =
        typeof data === "object" && data !== null && "branches" in data
          ? ((data as { branches?: Array<{ name: string }> }).branches ?? [])
          : [];
      console.info("[branches] branches loaded", {
        requester,
        repo: `${owner}/${name}`,
        branchCount: branches.length,
        sampleBranches: branches.slice(0, 10).map((branch) => branch.name),
      });
      if (branches.length === 0) {
        console.warn("[branches] branch list is empty", {
          requester,
          repo: `${owner}/${name}`,
        });
      }
    } else {
      console.error("[branches] control plane API error", {
        requester,
        repo: `${owner}/${name}`,
        status: response.status,
        data,
      });
    }
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("[branches] unexpected error fetching branches", {
      requester,
      repo: `${owner}/${name}`,
      error,
    });
    return NextResponse.json({ error: "Failed to fetch branches" }, { status: 500 });
  }
}
