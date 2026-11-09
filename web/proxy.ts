import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// The app was renamed to Point Taken; the old address forwards (308, keeps the path) to the new one.
const OLD_HOST = "fpl-selector.vercel.app";
const NEW_HOST = "point-taken-fpl.vercel.app";

export async function proxy(request: NextRequest) {
  if (request.headers.get("host") === OLD_HOST) {
    const url = request.nextUrl.clone();
    url.host = NEW_HOST;
    url.port = "";
    url.protocol = "https:";
    return NextResponse.redirect(url, 308);
  }
  return await updateSession(request);
}

export const config = {
  // Run on every route except static assets and image files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
