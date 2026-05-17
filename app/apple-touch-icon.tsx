import { ImageResponse } from "next/og";

export const size = {
  width: 180,
  height: 180
};

export const contentType = "image/png";

export default function AppleTouchIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background:
            "linear-gradient(180deg, rgb(246,246,241) 0%, rgb(233,233,225) 100%)",
          borderRadius: 36,
          color: "rgb(28,28,28)",
          fontSize: 82,
          fontWeight: 800,
          letterSpacing: -4
        }}
      >
        DWT
      </div>
    ),
    size
  );
}
