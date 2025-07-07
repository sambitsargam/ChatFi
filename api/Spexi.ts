// chatfi-imagery-api/index.ts

import express, { Request, Response } from 'express';
import multer from 'multer';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';
import { Web3Storage, File } from 'web3.storage';
import csvParser from 'csv-parser';
import * as h3 from 'h3-js';
import { Configuration, OpenAIApi } from 'openai';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const upload = multer({ dest: 'uploads/' });

const web3StorageToken = process.env.WEB3STORAGE_TOKEN || '';
const openaiApiKey = process.env.OPENAI_API_KEY || '';

const client = new Web3Storage({ token: web3StorageToken });
const openai = new OpenAIApi(new Configuration({ apiKey: openaiApiKey }));

const SAMPLE_ZIP_URL = 'https://spexi-data-sample-public.s3.ca-central-1.amazonaws.com/spexi_data_sample.zip';
const LOCAL_ZIP_PATH = 'sambit-local/data/spexi_data_sample.zip';
const METADATA_CSV_PATH = 'sambit-local/data/spexi_data_sample/manifest.csv';
// const IMAGERY_DIR = 'data/spexi_data_sample/images';

interface MetadataEntry {
  h3_index: string;
  image_file_name: string;
  [key: string]: string;
}

let metadata: MetadataEntry[] = [];

async function downloadAndUnzipSampleData(): Promise<void> {
  const writer = fs.createWriteStream(LOCAL_ZIP_PATH);
  const response = await axios({
    url: SAMPLE_ZIP_URL,
    method: 'GET',
    responseType: 'stream'
  });

  response.data.pipe(writer);
  await new Promise<void>((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  await fs.createReadStream(LOCAL_ZIP_PATH)
    .pipe(unzipper.Extract({ path: 'data/' }))
    .promise();

  console.log('✅ Sample data downloaded and extracted.');
}

function loadMetadata(): Promise<void> {
  return new Promise((resolve, reject) => {
    const results: MetadataEntry[] = [];
    fs.createReadStream(METADATA_CSV_PATH)
      .pipe(csvParser())
      .on('data', (row) => results.push(row))
      .on('end', () => {
        metadata = results;
        console.log('✅ Metadata loaded. Records:', metadata.length);
        resolve();
      })
      .on('error', reject);
  });
}

function getH3Cell(lat: string, lng: string): string {
  return h3.geoToH3(parseFloat(lat), parseFloat(lng), 9);
}

function findImagesByLocation(lat: string, lng: string): MetadataEntry[] {
  const cell = getH3Cell(lat, lng);
  return metadata.filter((entry) => entry.h3_index === cell);
}

async function summarizeWithOpenAI(data: any, base64Image: string | null = null): Promise<string> {
  let prompt = `Analyze and summarize the following aerial imagery metadata:\n${JSON.stringify(data, null, 2)}`;
  if (base64Image) {
    prompt += `\nAdditionally, consider the attached aerial image (base64 encoded). Provide insights including terrain, objects, structures, or notable features.`;
  }

  const messages = [
    { role: 'system', content: 'You are an expert in geospatial imagery analysis.' },
    { role: 'user', content: prompt }
  ];

  if (base64Image) {
    messages.push({ role: 'user', content: base64Image });
  }

  const response = await openai.createChatCompletion({
    model: 'gpt-4-vision-preview',
    messages
  });

  return response.data.choices[0].message?.content || '';
}

app.post('/analyze-base64', async (req: Request, res: Response) => {
  const { lat, lng, imageBase64 } = req.body;

  if (!lat || !lng || !imageBase64) {
    return res.status(400).json({ error: 'lat, lng, and imageBase64 are required.' });
  }

  try {
    if (!metadata.length) await loadMetadata();

    const matchingImages = findImagesByLocation(lat, lng);
    const aiData = {