export const RAG_ADMIN_USER_IDS = new Set([
  "107426926909517824",
  "116163000339136518",
  "102637456385392640",
  "114128631474683907",
]);

export const isRagAdminUser = (userId: string | undefined) =>
  userId !== undefined && RAG_ADMIN_USER_IDS.has(userId);
