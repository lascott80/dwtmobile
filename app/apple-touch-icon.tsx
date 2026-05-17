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
            "linear-gradient(180deg, rgb(255,255,255) 0%, rgb(242,242,247) 100%)",
          borderRadius: 36,
          color: "rgb(29,29,31)",
          fontSize: 76,
          fontWeight: 750,
          letterSpacing: -5
        }}
      >
        DWT
      </div>
    ),
    size
  );
}
