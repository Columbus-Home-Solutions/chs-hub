import logoUrl from "../../assets/chs-logo.png";
import { SOCIAL_POST_TYPES, type SocialPost, type SocialPostType } from "../../types";

const HYBRID = new Set<SocialPostType>(["seasonal_tips", "tips_tricks", "promotion"]);

export function postTypeLabel(type: string): string {
  return SOCIAL_POST_TYPES.find((t) => t.value === type)?.label ?? type;
}

export function photoSrc(post: SocialPost): string | null {
  if (post.ai_generated_image_url) return post.ai_generated_image_url;
  const photos = post.photos;
  if (photos && photos.length > 0) return photos[photos.length - 1].thumb_url;
  return null;
}

/** Square content tile. Seasonal, tips, and promotion posts always wear the
 *  branded frame (amber edge, headline, logo) over the AI image when one exists. */
export function PhotoTile({ post, size = "md" }: { post: SocialPost; size?: "sm" | "md" | "lg" }) {
  const hybrid = HYBRID.has(post.post_type);
  const src = photoSrc(post);
  const headline = (post.caption || "").split("\n")[0].trim() || postTypeLabel(post.post_type);
  const cls = `photo-tile photo-tile--${size}${hybrid ? " photo-tile--hybrid" : ""} photo-tile--${post.post_type}`;

  return (
    <div class={cls} aria-hidden="true">
      {src ? <img src={src} alt="" class="photo-tile__img" /> : null}
      {hybrid ? (
        <>
          <div class="photo-tile__scrim">{headline}</div>
          <img src={logoUrl} alt="" class="photo-tile__mark" />
        </>
      ) : !src ? (
        <span class="photo-tile__empty">No photo</span>
      ) : null}
    </div>
  );
}
