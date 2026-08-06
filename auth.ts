import { PrismaAdapter } from "@auth/prisma-adapter";
import { compare } from "bcryptjs";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";

import { db } from "@/lib/db";
import { consumeSignInGrant } from "@/lib/two-factor";

const credentialsSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});
const grantSchema = z.object({ grant: z.string().min(32).max(128) });

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: "jwt" },
  pages: { signIn: "/auth/signin" },
  providers: [
    Credentials({
      name: "Wallaby account",
      credentials: {
        username: { label: "Username or email", type: "text" },
        password: { label: "Password", type: "password" },
        grant: { label: "One-time sign-in grant", type: "text" },
      },
      async authorize(rawCredentials) {
        const parsedGrant = grantSchema.safeParse(rawCredentials);
        if (parsedGrant.success) {
          const user = await consumeSignInGrant(parsedGrant.data.grant);
          if (!user) return null;
          return { id: user.id, name: user.name ?? user.username, email: user.email, role: user.role, sessionVersion: user.sessionVersion };
        }
        const parsed = credentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) return null;

        const { username, password } = parsed.data;
        const user = await db.user.findFirst({
          where: { OR: [{ username }, { email: username.toLowerCase() }] },
        });
        if (!user?.passwordHash || user.twoFactorMethod !== "NONE" || !(await compare(password, user.passwordHash))) return null;
        return { id: user.id, name: user.name ?? user.username, email: user.email, role: user.role, sessionVersion: user.sessionVersion };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.sessionVersion = user.sessionVersion;
      } else if (typeof token.id === "string") {
        const account = await db.user.findUnique({ where: { id: token.id }, select: { role: true, sessionVersion: true } });
        if (!account || account.sessionVersion !== token.sessionVersion) {
          delete token.id;
          delete token.role;
          delete token.sessionVersion;
        } else {
          token.role = account.role;
        }
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as "USER" | "ADMIN";
      }
      return session;
    },
  },
});
