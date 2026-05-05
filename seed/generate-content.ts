/**
 * Training Content Generator
 * Generates slides and quiz questions for all 15 SOP-based courses.
 * Run with: npx ts-node seed/generate-content.ts
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { courseSlides } from './content/all-slides';
import { courseQuizzes } from './content/all-quizzes';

dotenv.config();

async function generate(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env['DATABASE_URL'] ||
      `postgresql://${process.env['DATABASE_USER'] || 'postgres'}:${process.env['DATABASE_PASSWORD'] || 'postgres'}@${process.env['DATABASE_HOST'] || 'localhost'}:${process.env['DATABASE_PORT'] || '5432'}/${process.env['DATABASE_NAME'] || 'libreclinica'}`,
  });

  try {
    // Insert slides for each course
    for (const [courseCode, slides] of Object.entries(courseSlides)) {
      const courseResult = await pool.query(
        'SELECT id FROM acc_training_courses WHERE course_code = $1', [courseCode]
      );
      if (courseResult.rows.length === 0) {
        console.log(`Course ${courseCode} not found, skipping slides`);
        continue;
      }
      const courseId = courseResult.rows[0].id;

      // Check if slides already exist
      const existing = await pool.query(
        'SELECT COUNT(*) as cnt FROM acc_training_slides WHERE course_id = $1', [courseId]
      );
      if (parseInt(existing.rows[0].cnt) > 0) {
        console.log(`Slides already exist for ${courseCode}, skipping`);
        continue;
      }

      for (const slide of slides) {
        await pool.query(
          `INSERT INTO acc_training_slides (course_id, title, content, slide_type, order_index)
           VALUES ($1, $2, $3, $4, $5)`,
          [courseId, slide.title, slide.content, slide.type || 'text', slide.order]
        );
      }
      console.log(`Inserted ${slides.length} slides for ${courseCode}`);
    }

    // Insert quiz questions for each course
    for (const [courseCode, questions] of Object.entries(courseQuizzes)) {
      const courseResult = await pool.query(
        'SELECT id FROM acc_training_courses WHERE course_code = $1', [courseCode]
      );
      if (courseResult.rows.length === 0) {
        console.log(`Course ${courseCode} not found, skipping questions`);
        continue;
      }
      const courseId = courseResult.rows[0].id;

      const existing = await pool.query(
        'SELECT COUNT(*) as cnt FROM acc_training_questions WHERE course_id = $1', [courseId]
      );
      if (parseInt(existing.rows[0].cnt) > 0) {
        console.log(`Questions already exist for ${courseCode}, skipping`);
        continue;
      }

      for (const q of questions) {
        await pool.query(
          `INSERT INTO acc_training_questions (course_id, question_text, question_type, options, explanation, order_index)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [courseId, q.text, q.type, JSON.stringify(q.options), q.explanation, q.order]
        );
      }
      console.log(`Inserted ${questions.length} questions for ${courseCode}`);
    }

    console.log('Content generation complete!');
  } catch (error) {
    console.error('Failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

generate();
