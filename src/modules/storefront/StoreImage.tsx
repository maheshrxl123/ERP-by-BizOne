import { useEffect, useRef, useState } from 'react';

interface StoreImageProps {
  src: string;
  fallbackSrc?: string;
  alt: string;
  width?: number;
  height?: number;
  loading?: 'lazy' | 'eager';
  eager?: boolean;
  skeletonClassName?: string;
  className?: string;
  wrapperClassName?: string;
}

export function StoreImage({
  src,
  fallbackSrc,
  alt,
  width,
  height,
  loading,
  eager = false,
  skeletonClassName = 'bg-stone-200',
  className = '',
  wrapperClassName = 'relative w-full h-full',
}: StoreImageProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [activeSrc, setActiveSrc] = useState(src);
  const resolvedLoading = loading ?? (eager ? 'eager' : 'lazy');

  useEffect(() => {
    setActiveSrc(src);
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
      setLoaded(true);
    } else {
      setLoaded(false);
    }
  }, [src]);

  return (
    <div className={wrapperClassName}>
      {!loaded && (
        <div
          aria-hidden="true"
          className={`absolute inset-0 animate-pulse ${skeletonClassName}`}
        />
      )}
      <img
        ref={imgRef}
        src={activeSrc}
        alt={alt}
        width={width}
        height={height}
        loading={resolvedLoading}
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
        onError={() => {
          if (fallbackSrc && activeSrc !== fallbackSrc) {
            setActiveSrc(fallbackSrc);
          } else {
            setLoaded(true);
          }
        }}
        className={`${className} transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  );
}
