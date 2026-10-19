declare module "virtual:holoim-knowledge" {
  export const images: Record<string, string>;
  const documents: Array<{
    path: string;
    content: string;
    title: string | null;
    description: string;
  }>;
  export default documents;
}
