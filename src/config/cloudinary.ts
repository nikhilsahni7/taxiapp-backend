// cloudinary.js
import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME!,
  api_key: process.env.CLOUDINARY_API_KEY!,
  api_secret: process.env.CLOUDINARY_API_SECRET!,
});

/**
 * Upload image to Cloudinary with retry logic and proper error handling
 * @param fileBuffer - Buffer containing the image data
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param timeout - Upload timeout in milliseconds (default: 30000)
 * @returns Promise<string> - Secure URL of uploaded image
 */
export const uploadImage = async (
  fileBuffer: Buffer,
  maxRetries: number = 3,
  timeout: number = 30000
): Promise<string> => {
  // Validate input
  if (!fileBuffer || fileBuffer.length === 0) {
    throw new Error("Invalid file buffer provided");
  }

  // Validate file size (max 10MB)
  if (fileBuffer.length > 10 * 1024 * 1024) {
    throw new Error("File size exceeds maximum limit of 10MB");
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📤 Cloudinary upload attempt ${attempt}/${maxRetries}, buffer size: ${fileBuffer.length} bytes`);

      const result = await new Promise<string>((resolve, reject) => {
        // Set up timeout
        const timeoutId = setTimeout(() => {
          reject(new Error(`Upload timeout after ${timeout}ms`));
        }, timeout);

        cloudinary.uploader
          .upload_stream(
            {
              folder: "auth_images",
              resource_type: "auto",
              quality: "auto",
              fetch_format: "auto",
              transformation: [
                { width: 1920, height: 1080, crop: "limit" },
                { quality: "auto:good" }
              ]
            },
            (error, result) => {
              clearTimeout(timeoutId);

              if (error) {
                console.error(`❌ Cloudinary upload error (attempt ${attempt}):`, error);
                reject(new Error(`Cloudinary upload failed: ${error.message}`));
              } else if (result && result.secure_url) {
                console.log(`✅ Cloudinary upload successful (attempt ${attempt}): ${result.secure_url}`);
                resolve(result.secure_url);
              } else {
                console.error(`❌ Cloudinary upload failed (attempt ${attempt}): No result or secure_url`);
                reject(new Error("Cloudinary upload failed: No secure URL returned"));
              }
            }
          )
          .end(fileBuffer);
      });

      return result;

    } catch (error: any) {
      console.error(`❌ Upload attempt ${attempt} failed:`, error.message);

      // If this is the last attempt, throw the error
      if (attempt === maxRetries) {
        throw new Error(`Failed to upload after ${maxRetries} attempts: ${error.message}`);
      }

      // Wait before retry (exponential backoff)
      const waitTime = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s...
      console.log(`⏳ Retrying upload in ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  throw new Error("Upload failed after maximum retry attempts");
};

/**
 * Validate file type and size before upload
 * @param file - Multer file object
 * @returns boolean - true if valid, throws error if invalid
 */
export const validateFile = (file: Express.Multer.File): boolean => {
  // Check file size (max 10MB)
  if (file.size > 10 * 1024 * 1024) {
    throw new Error(`File ${file.originalname} exceeds maximum size of 10MB`);
  }

  // Check file type
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
  if (!allowedTypes.includes(file.mimetype)) {
    throw new Error(`File ${file.originalname} has invalid type. Allowed types: ${allowedTypes.join(', ')}`);
  }

  // Check if buffer exists
  if (!file.buffer || file.buffer.length === 0) {
    throw new Error(`File ${file.originalname} has no data`);
  }

  return true;
};

/**
 * Upload multiple files with proper error handling
 * @param files - Array of multer files
 * @returns Promise<string[]> - Array of secure URLs
 */
export const uploadMultipleImages = async (files: Express.Multer.File[]): Promise<string[]> => {
  if (!files || files.length === 0) {
    return [];
  }

  const uploadPromises = files.map(async (file, index) => {
    try {
      validateFile(file);
      console.log(`📤 Uploading file ${index + 1}/${files.length}: ${file.originalname}`);
      return await uploadImage(file.buffer);
    } catch (error: any) {
      console.error(`❌ Failed to upload file ${file.originalname}:`, error.message);
      throw new Error(`Failed to upload ${file.originalname}: ${error.message}`);
    }
  });

  return await Promise.all(uploadPromises);
};
