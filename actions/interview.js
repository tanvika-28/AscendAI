"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

function getFallbackQuestions() {
  return [
    {
      question: "What does AI stand for?",
      options: ["Artificial Intelligence", "Automated Input", "Analog Interface", "Applied Innovation"],
      correctAnswer: "Artificial Intelligence",
      explanation: "AI stands for Artificial Intelligence, which refers to machines simulating human intelligence."
    },
    {
      question: "Which is a supervised learning algorithm?",
      options: ["K-Means", "Decision Trees", "PCA", "DBSCAN"],
      correctAnswer: "Decision Trees",
      explanation: "Decision Trees are used in supervised learning tasks."
    },
    // Add 8 more fallback questions similarly...
  ];
}

export async function generateQuiz() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
    select: { industry: true, skills: true },
  });

  if (!user) throw new Error("User not found");

  const prompt = `
    Generate 10 technical interview questions for a ${user.industry} professional${
    user.skills?.length ? ` with expertise in ${user.skills.join(", ")}` : ""
  }.
    Each question should be multiple choice with 4 options.
    Return in JSON:
    {
      "questions": [
        {
          "question": "string",
          "options": ["string", "string", "string", "string"],
          "correctAnswer": "string",
          "explanation": "string"
        }
      ]
    }
  `;

  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      const result = await model.generateContent(prompt);
      const response = result.response;
      const text = response.text();
      const cleanedText = text.replace(/```(?:json)?\n?/g, "").trim();
      const quiz = JSON.parse(cleanedText);

      if (quiz?.questions?.length >= 5) {  // sanity check
        return quiz.questions;
      } else {
        console.warn("Generated quiz is invalid, falling back if retries fail...");
        throw new Error("Generated quiz invalid.");
      }

    } catch (error) {
      console.error(`Gemini attempt ${attempt + 1} failed:`, error);
      attempt++;
      await new Promise(resolve => setTimeout(resolve, 2000));  // wait before retry
    }
  }

  console.error("All Gemini retries failed. Returning fallback questions.");
  return getFallbackQuestions();
}


export async function saveQuizResult(questions, answers, score) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  const questionResults = questions.map((q, index) => ({
    question: q.question,
    answer: q.correctAnswer,
    userAnswer: answers[index],
    isCorrect: q.correctAnswer === answers[index],
    explanation: q.explanation,
  }));

  const wrongAnswers = questionResults.filter((q) => !q.isCorrect);

  let improvementTip = null;
  if (wrongAnswers.length > 0) {
    const wrongQuestionsText = wrongAnswers
      .map(
        (q) =>
          `Question: "${q.question}"\nCorrect Answer: "${q.answer}"\nUser Answer: "${q.userAnswer}"`
      )
      .join("\n\n");

    const improvementPrompt = `
      The user got the following ${user.industry} questions wrong:
      ${wrongQuestionsText}
      Provide a concise improvement tip (< 2 sentences). Focus on knowledge gaps, avoid repeating mistakes directly.
    `;

    try {
      const tipResult = await model.generateContent(improvementPrompt);
      improvementTip = tipResult.response.text().trim();
    } catch (error) {
      console.error("Error generating improvement tip:", error);
    }
  }

  try {
    const assessment = await db.assessment.create({
      data: {
        userId: user.id,
        quizScore: score,
        questions: questionResults,
        category: "Technical",
        improvementTip,
      },
    });

    return assessment;

  } catch (error) {
    console.error("Error saving quiz result:", error);
    throw new Error("Failed to save quiz result");
  }
}


export async function getAssessments() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  try {
    const assessments = await db.assessment.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });

    return assessments;

  } catch (error) {
    console.error("Error fetching assessments:", error);
    throw new Error("Failed to fetch assessments");
  }
}
