import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    role?: "USER" | "ADMIN";
    sessionVersion?: number;
  }

  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      role: "USER" | "ADMIN";
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: "USER" | "ADMIN";
    sessionVersion?: number;
  }
}
