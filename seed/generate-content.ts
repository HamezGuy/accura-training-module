/**
 * Training Content Generator
 * Generates slides and quiz questions for all 15 SOP-based courses.
 * Run with: npx ts-node seed/generate-content.ts
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { courseSlides } from './content/all-slides';
import { courseQuizzes } from './content/all-quizzes';
import { courseExercises } from './content/exercises';

dotenv.config();

const RAVE_PRIORITY_COURSES = ['LOGIN-NAV', 'DATA-ENTRY', 'PATIENT-MGMT', 'QUERY-MGMT', 'FORM-CREATE', 'VAL-RULES', 'STUDY-MGMT', 'BRANCHING', 'GCP-101', 'CFR11-101', 'HIPAA-101', 'E-SIGN', 'DATA-EXPORT', 'REPORTS', 'USER-MGMT', 'DATA-LOCKS', 'SDV', 'WORKFLOW', 'RANDOMIZE'];

async function generate(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env['DATABASE_URL'] ||
      `postgresql://${process.env['DATABASE_USER'] || 'postgres'}:${process.env['DATABASE_PASSWORD'] || 'postgres'}@${process.env['DATABASE_HOST'] || 'localhost'}:${process.env['DATABASE_PORT'] || '5432'}/${process.env['DATABASE_NAME'] || 'libreclinica'}`,
  });

  try {
    // Try loading Rave-pattern content for priority courses
    let raveCourseContent: Array<{ courseCode: string; order: number; title: string; type: string; content: string; interactiveConfig?: Record<string, unknown> }> = [];
    try {
      const fs = await import('fs');
      const path = await import('path');
      const ravePath = path.join(__dirname, 'content', 'rave-courses.ts');
      if (fs.existsSync(ravePath)) {
        const raveModule = require('./content/rave-courses');
        raveCourseContent = raveModule.raveCourseContent || [];
        console.log(`Loaded ${raveCourseContent.length} Rave-pattern slides`);
      } else {
        console.log('No rave-courses.ts found yet, using standard content for priority courses');
      }
    } catch (e) {
      console.log('Rave content not available, using standard content');
    }

    // Insert Rave-pattern content for priority courses (replaces standard slides)
    for (const courseCode of RAVE_PRIORITY_COURSES) {
      const courseResult = await pool.query(
        'SELECT id FROM acc_training_courses WHERE course_code = $1', [courseCode]
      );
      if (courseResult.rows.length === 0) continue;
      const courseId = courseResult.rows[0].id;

      const raveSlides = raveCourseContent.filter(s => s.courseCode === courseCode);
      if (raveSlides.length === 0) continue;

      // Clear existing slides for this course (replace with Rave content)
      await pool.query('DELETE FROM acc_training_slides WHERE course_id = $1', [courseId]);

      for (const slide of raveSlides) {
        await pool.query(
          `INSERT INTO acc_training_slides (course_id, title, content, slide_type, order_index, interactive_config)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [courseId, slide.title, slide.content, slide.type, slide.order, slide.interactiveConfig ? JSON.stringify(slide.interactiveConfig) : null]
        );
      }
      console.log(`Inserted ${raveSlides.length} Rave-pattern slides for ${courseCode}`);
    }

    // Insert standard slides for non-priority courses
    for (const [courseCode, slides] of Object.entries(courseSlides)) {
      if (RAVE_PRIORITY_COURSES.includes(courseCode)) continue;

      const courseResult = await pool.query(
        'SELECT id FROM acc_training_courses WHERE course_code = $1', [courseCode]
      );
      if (courseResult.rows.length === 0) continue;
      const courseId = courseResult.rows[0].id;

      const existing = await pool.query(
        'SELECT COUNT(*) as cnt FROM acc_training_slides WHERE course_id = $1', [courseId]
      );
      if (parseInt(existing.rows[0].cnt) > 0) continue;

      for (const slide of slides) {
        await pool.query(
          `INSERT INTO acc_training_slides (course_id, title, content, slide_type, order_index)
           VALUES ($1, $2, $3, $4, $5)`,
          [courseId, slide.title, slide.content, slide.type || 'text', slide.order]
        );
      }
      console.log(`Inserted ${slides.length} slides for ${courseCode}`);
    }

    // Insert exercises for non-priority courses
    for (const exercise of courseExercises) {
      if (RAVE_PRIORITY_COURSES.includes(exercise.courseCode)) continue;
      const courseResult = await pool.query(
        'SELECT id FROM acc_training_courses WHERE course_code = $1', [exercise.courseCode]
      );
      if (courseResult.rows.length === 0) continue;
      const courseId = courseResult.rows[0].id;

      await pool.query(
        `INSERT INTO acc_training_slides (course_id, title, content, slide_type, order_index, interactive_config)
         VALUES ($1, $2, $3, 'interactive', $4, $5)
         ON CONFLICT DO NOTHING`,
        [courseId, exercise.title, exercise.config.instruction || '', exercise.order, JSON.stringify(exercise.config)]
      );
    }

    // Insert/update quiz questions for all courses
    for (const [courseCode, questions] of Object.entries(courseQuizzes)) {
      const courseResult = await pool.query(
        'SELECT id FROM acc_training_courses WHERE course_code = $1', [courseCode]
      );
      if (courseResult.rows.length === 0) continue;
      const courseId = courseResult.rows[0].id;

      // Replace questions for priority courses (expanded set)
      if (RAVE_PRIORITY_COURSES.includes(courseCode)) {
        await pool.query('DELETE FROM acc_training_questions WHERE course_id = $1', [courseId]);
      } else {
        const existing = await pool.query(
          'SELECT COUNT(*) as cnt FROM acc_training_questions WHERE course_id = $1', [courseId]
        );
        if (parseInt(existing.rows[0].cnt) > 0) continue;
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
