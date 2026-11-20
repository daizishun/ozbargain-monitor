// 顶部安全区垫片：替代原来 `@hatch/space-sdk/client` 的
// SafeAreaTopScrim。只是一个固定在顶部的 div，用背景色盖住刘海 /
// 状态栏区域；在桌面上安全区高度为 0，不影响布局。

import type { CSSProperties, ReactNode } from "react";

export interface SafeAreaTopScrimProps {
  backgroundColor?: string;
  zIndex?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function SafeAreaTopScrim({
  backgroundColor,
  zIndex = 40,
  className,
  style,
}: SafeAreaTopScrimProps) {
  return (
    <div
      aria-hidden
      className={className}
      style={{
        ...style,
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex,
        pointerEvents: "none",
        height: "env(safe-area-inset-top, 0px)",
        backgroundColor: backgroundColor ?? "var(--bg)",
      }}
    />
  );
}
