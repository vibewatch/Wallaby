import { deleteApiTagsByLabel } from "@/lib/api-tags";

export async function DELETE(request: Request) { return deleteApiTagsByLabel(request, true); }
