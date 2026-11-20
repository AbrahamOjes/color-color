import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

// Private-testing gate: HTTP basic auth over the whole site while SITE_PASSWORD is set.
// Unset (local dev) means no gate. Any username is accepted; only the password counts.
// This hides the frontend, not the game -- the contracts are public on Polygon regardless.
export function proxy(request: NextRequest) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return NextResponse.next();

  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const given = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
    const expected = Buffer.from(password);
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return NextResponse.next();
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="ColorColor private test"' },
  });
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
