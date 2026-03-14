type ARQuickLookLinkProps = {
  hologramId: string;
};

export function ARQuickLookLink({ hologramId }: ARQuickLookLinkProps) {
  const apiOrigin = import.meta.env.VITE_API_ORIGIN ?? "";
  const usdzUrl = `${apiOrigin}/api/holograms/${hologramId}/usdz`;
  const transparentPixel = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";

  return (
    <a
      rel="ar"
      href={usdzUrl}
      className="ar-trigger-button ar-quicklook-link"
      aria-label="View in AR"
      title="View in Augmented Reality"
    >
      <img
        src={transparentPixel}
        alt=""
        aria-hidden="true"
        width={1}
        height={1}
        style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}
      />
      View in AR
    </a>
  );
}
