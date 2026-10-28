declare module "virtual:holoim-knowledge" {
  const documents: Array<{
    path: string;
    content: string;
    title: string | null;
    description: string;
  }>;
  export default documents;
}
