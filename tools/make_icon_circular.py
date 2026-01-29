import sys
from PIL import Image, ImageDraw, ImageOps

def process_icon(input_path, output_path):
    print(f"Processing {input_path} -> {output_path}")

    # 1. Open source image (The Hexagon)
    try:
        src = Image.open(input_path).convert("RGBA")
    except Exception as e:
        print(f"Error opening image: {e}")
        return

    # 2. Setup canvas
    size = src.size
    # Ensure square
    dim = min(size)
    src = src.resize((dim, dim), Image.LANCZOS)

    # 3. Create White Circle Background
    # Create a new image for the background
    out_img = Image.new("RGBA", (dim, dim), (0, 0, 0, 0))
    draw = ImageDraw.Draw(out_img)

    # Draw White Circle taking up the full space
    # (Leaving 1px margin for anti-aliasing safety)
    margin = 0
    draw.ellipse((margin, margin, dim-margin, dim-margin), fill="#FFFFFF")

    # 4. Resize and Paste Hexagon
    # We want the hexagon significantly smaller than the circle to look like an icon inside a badge
    # e.g., 65% size
    scale = 0.85
    icon_dim = int(dim * scale)
    icon_resized = src.resize((icon_dim, icon_dim), Image.LANCZOS)

    # Calculate offset to center
    offset = (dim - icon_dim) // 2

    # Paste.
    # Since source is solid white background (as requested to remove grid artifact),
    # we just paste it. The final circular mask will trim the corners.
    out_img.paste(icon_resized, (offset, offset))

    # 5. Mask the final output to be strictly circular (clean edges)
    mask = Image.new("L", (dim, dim), 0)
    draw_mask = ImageDraw.Draw(mask)
    draw_mask.ellipse((0, 0, dim, dim), fill=255)

    # Apply circular mask to alpha channel
    # This ensures corners are transparent
    out_img.putalpha(mask)

    out_img.save(output_path, "PNG")
    print("Done.")

if __name__ == "__main__":
    process_icon(
        "/Users/sakyahong/.gemini/antigravity/brain/71784948-f90d-489d-9f73-60d9d421807e/plugin_icon_hexagon_white_1769654402742.png",
        "/Volumes/HAS2T/Project/HeraStudio/Projects-Chats-Skiils/resources/plugin-icon.png"
    )
