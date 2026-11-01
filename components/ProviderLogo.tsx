"use client";

import type { Provider } from "@/lib/providers";

export function ProviderLogo({
  provider,
  size = 24,
}: {
  provider: Provider;
  size?: number;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/providers/${provider.logo}`}
      alt=""
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        filter: provider.mono ? "invert(1)" : undefined,
      }}
      aria-hidden
    />
  );
}
