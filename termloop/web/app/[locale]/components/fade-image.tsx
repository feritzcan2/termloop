"use client";

import Image, { type ImageProps } from "next/image";
import { useState } from "react";

export function FadeImage(props: ImageProps) {
  const [loaded, setLoaded] = useState(false);
  const { alt, className, onLoad, ...imageProps } = props;

  return (
    <Image
      {...imageProps}
      alt={alt}
      placeholder={undefined}
      className={`${className ?? ""} transition-opacity duration-700 ${loaded ? "opacity-100" : "opacity-0"}`}
      onLoad={(event) => {
        onLoad?.(event);
        setLoaded(true);
      }}
    />
  );
}
