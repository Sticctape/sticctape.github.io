# R2 Image Storage Setup Guide

## Backend Setup Complete ✅

All backend code is ready in the Worker. You now need to:

### Step 1: Create R2 Bucket (if not already created)

Run in terminal:
```bash
wrangler r2 bucket create streetersdistillery-images
```

### Step 2: Set Up Custom Domain for Images (Optional but Recommended)

This makes image URLs nice: `https://images.streeter.cc/...`

In Cloudflare Dashboard:
1. Go to R2 → streetersdistillery-images
2. Settings → Custom Domains
3. Add: `images.streeter.cc`
4. Point DNS CNAME to your R2 bucket endpoint

**Without custom domain**, images will be: `https://streetersdistillery-images.r2.cloudflarestorage.com/...`

### Step 3: Deploy Worker

```bash
wrangler deploy
```

### Step 4: Apply Database Migration

If you haven't already, run:
```bash
wrangler d1 migrations apply cf-inventory --remote
```

This adds the UPC field (from migration 0002) if not already applied.

## Frontend Features Ready ✅

### Image Upload
- Click the image area or drag/drop to upload
- Max 5MB per image
- Automatic preview
- Only works when **editing** a bottle (save it first)
- Shows upload status (loading, success, error)

### Image Storage
- Images stored in R2 bucket
- Organized in `/bottles/` prefix
- URL format: `bottles/{bottleId}-{timestamp}.{ext}`
- Cached for 1 year
- Automatically stored in database

### Image Management
- View current image when editing
- Upload new image replaces old one
- Delete image button removes from R2 and database
- Image field hidden when adding new bottle (shows after save)

## API Endpoints Added

### Upload Image
```
POST /api/admin/bottles/{bottleId}/image
Content-Type: image/{type}
```
Body: Raw image file data

Response:
```json
{
  "success": true,
  "imageUrl": "https://images.streeter.cc/bottles/...",
  "filename": "bottles/..."
}
```

### Delete Image
```
DELETE /api/admin/bottles/{bottleId}/image
```

## Testing

1. Deploy the Worker
2. Apply migrations
3. Create/edit a bottle
4. Upload an image
5. Check R2 bucket in Cloudflare Dashboard
6. Verify image appears in preview
7. Test delete functionality

## Future Enhancements

- Auto-download images from UPC lookup
- Batch upload multiple images
- Image compression
- Thumbnail generation
- Image gallery view

