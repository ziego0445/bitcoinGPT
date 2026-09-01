// Kakao AdFit placeholder slot — shared across every dashboard tab so ad placement is
// consistent everywhere, not just the original 역추세매매 tab it started on. The `<ins>`
// itself renders nothing (`display: none`) until Kakao's own loader script finds it by
// class name and fills it in; this component only marks where a unit goes.
export default function KakaoAd({ unit, width, height }: { unit: string; width: number; height: number }) {
  return (
    <div className="flex min-h-[120px] items-center justify-center border border-[#1b2938] bg-[#080d13] p-2">
      <ins className="kakao_ad_area" style={{ display: "none" }} data-ad-unit={unit} data-ad-width={width} data-ad-height={height} />
    </div>
  )
}
