import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

export const ai = new GoogleGenAI({ apiKey: apiKey || "" });

export const MODELS = {
  TEXT: "gemini-3.1-pro-preview",
  FLASH: "gemini-3-flash-preview",
  IMAGE: "gemini-2.5-flash-image",
  TTS: "gemini-2.5-flash-preview-tts",
};

export async function synthesizeAudio(text: string, voice: 'Kore' | 'Puck' = 'Kore') {
  const response = await ai.models.generateContent({
    model: MODELS.TTS,
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice },
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (base64Audio) {
    return `data:audio/mp3;base64,${base64Audio}`;
  }
  return null;
}

export async function generateQuestions(submissionText: string, rubricText: string, briefText: string, count: number = 12) {
  const model = ai.models.generateContent({
    model: MODELS.TEXT,
    contents: `
      You are an academic integrity interviewer. 
      Based on the following student submission, the assignment brief, and the grading rubric, generate ${count} interview questions to verify the student's understanding of their work.
      
      Assignment Brief:
      ${briefText}
      
      Grading Rubric:
      ${rubricText}
      
      Student Submission:
      ${submissionText}
      
      Requirements:
      1. Questions should be specific to the student's work.
      2. Questions should test comprehension, not just recall.
      3. Provide each question in both English and Arabic.
      4. Return the result as a JSON array of objects with "english" and "arabic" keys.
    `,
    config: {
      responseMimeType: "application/json",
    }
  });

  const result = await model;
  return JSON.parse(result.text || "[]");
}
