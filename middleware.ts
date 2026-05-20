import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ADMIN_TOKEN = process.env.DISNEY_WAIT_TIMES_ADMIN_TOKEN || process.env.DWT_ADMIN_TOKEN || "";

function readBasicPassword(header: string) {
  if (!header.startsWith("Basic ")) return "";
  try {
    const decoded = atob(header.slice("Basic ".length));
    return decoded.split(":").slice(1).join(":");
  } catch {
    return "";
  }
}

function hasAdminAccess(request: NextRequest) {
  if (!ADMIN_TOKEN && process.env.NODE_ENV !== "production") {
    return true;
  }

  const authorization = request.headers.get("authorization") || "";
  const bearerToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const basicPassword = readBasicPassword(authorization);
  const headerToken = request.headers.get("x-admin-token") || "";

  return [bearerToken, basicPassword, headerToken].some((token) => token && token === ADMIN_TOKEN);
}

export function middleware(request: NextRequest) {
  if (hasAdminAccess(request)) {
    return NextResponse.next();
  }

  return new NextResponse("Admin access required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Disney Wait Times Ops"',
      "Cache-Control": "no-store"
    }
  });
}

export const config = {
  matcher: ["/stats/:path*", "/admin/:path*"]
};
