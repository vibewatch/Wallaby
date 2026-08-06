import { notFound, redirect } from "next/navigation";

import { auth } from "@/auth";

export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) redirect("/auth/signin");
  return session.user;
}

export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "ADMIN") notFound();
  return user;
}
