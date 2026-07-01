/**
 * Seed script — populates the DynamoDB Books table with sample data.
 * Run with: npx ts-node scripts/seed-data.ts
 *
 * Requires AWS credentials configured and the Books table to exist.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.BOOKS_TABLE_NAME || 'AnyCompanyRead-Books';

interface SeedBook {
  title: string;
  author: string;
  isbn: string;
  genre: string;
  description: string;
  price: number;
  coverImageUrl: string;
  rating: number;
  pageCount: number;
  publishedYear: number;
}

const sampleBooks: SeedBook[] = [
  {
    title: 'The Midnight Library',
    author: 'Matt Haig',
    isbn: '978-0525559474',
    genre: 'Fiction',
    description: 'Between life and death there is a library, and within that library, the shelves go on forever. Every book provides a chance to try another life you could have lived.',
    price: 14.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=300&h=400&fit=crop',
    rating: 4.5,
    pageCount: 304,
    publishedYear: 2020,
  },
  {
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    isbn: '978-0593135204',
    genre: 'Science Fiction',
    description: 'A lone astronaut must save the earth from disaster in this propulsive interstellar adventure.',
    price: 16.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?w=300&h=400&fit=crop',
    rating: 4.8,
    pageCount: 496,
    publishedYear: 2021,
  },
  {
    title: 'Atomic Habits',
    author: 'James Clear',
    isbn: '978-0735211292',
    genre: 'Self-Help',
    description: 'An easy and proven way to build good habits and break bad ones. Tiny changes, remarkable results.',
    price: 13.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1589829085413-56de8ae18c73?w=300&h=400&fit=crop',
    rating: 4.7,
    pageCount: 320,
    publishedYear: 2018,
  },
  {
    title: 'The Name of the Wind',
    author: 'Patrick Rothfuss',
    isbn: '978-0756404741',
    genre: 'Fantasy',
    description: 'The riveting first-person narrative of Kvothe, a young man who grows to be one of the most notorious wizards his world has ever seen.',
    price: 15.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=300&h=400&fit=crop',
    rating: 4.6,
    pageCount: 662,
    publishedYear: 2007,
  },
  {
    title: 'Dune',
    author: 'Frank Herbert',
    isbn: '978-0441172719',
    genre: 'Science Fiction',
    description: 'Set on the desert planet Arrakis, Dune is the story of the boy Paul Atreides, heir to a noble family tasked with ruling an inhospitable world.',
    price: 12.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1547036967-23d11aacaee0?w=300&h=400&fit=crop',
    rating: 4.4,
    pageCount: 688,
    publishedYear: 1965,
  },
  {
    title: 'Gone Girl',
    author: 'Gillian Flynn',
    isbn: '978-0307588371',
    genre: 'Thriller',
    description: 'On a warm summer morning in North Carthage, Missouri, it is Nick and Amy Dunne\'s fifth wedding anniversary.',
    price: 11.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1587876931567-564ce588bfbd?w=300&h=400&fit=crop',
    rating: 4.1,
    pageCount: 432,
    publishedYear: 2012,
  },
  {
    title: 'Sapiens: A Brief History of Humankind',
    author: 'Yuval Noah Harari',
    isbn: '978-0062316097',
    genre: 'History',
    description: 'From a renowned historian comes a groundbreaking narrative of humanity\'s creation and evolution.',
    price: 18.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=300&h=400&fit=crop',
    rating: 4.4,
    pageCount: 464,
    publishedYear: 2015,
  },
  {
    title: 'The Silent Patient',
    author: 'Alex Michaelides',
    isbn: '978-1250301697',
    genre: 'Mystery',
    description: 'A woman shoots her husband five times and then never speaks another word. A criminal psychotherapist is determined to unravel the mystery.',
    price: 14.49,
    coverImageUrl: 'https://images.unsplash.com/photo-1481627834876-b7833e8f5570?w=300&h=400&fit=crop',
    rating: 4.2,
    pageCount: 336,
    publishedYear: 2019,
  },
  {
    title: 'Educated',
    author: 'Tara Westover',
    isbn: '978-0399590504',
    genre: 'Biography',
    description: 'A memoir about a young woman who, kept out of school, leaves her survivalist family and goes on to earn a PhD from Cambridge University.',
    price: 13.49,
    coverImageUrl: 'https://images.unsplash.com/photo-1497633762265-9d179a990aa6?w=300&h=400&fit=crop',
    rating: 4.6,
    pageCount: 352,
    publishedYear: 2018,
  },
  {
    title: 'The Hobbit',
    author: 'J.R.R. Tolkien',
    isbn: '978-0547928227',
    genre: 'Fantasy',
    description: 'Bilbo Baggins is a hobbit who enjoys a comfortable, unambitious life until the wizard Gandalf and a company of dwarves arrive.',
    price: 10.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1506466010722-395aa2bef877?w=300&h=400&fit=crop',
    rating: 4.7,
    pageCount: 310,
    publishedYear: 1937,
  },
  {
    title: 'A Brief History of Time',
    author: 'Stephen Hawking',
    isbn: '978-0553380163',
    genre: 'Science',
    description: 'A landmark volume in science writing by one of the great minds of our time, exploring the nature of time and the universe.',
    price: 14.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=300&h=400&fit=crop',
    rating: 4.3,
    pageCount: 212,
    publishedYear: 1988,
  },
  {
    title: 'Clean Code',
    author: 'Robert C. Martin',
    isbn: '978-0132350884',
    genre: 'Technology',
    description: 'A handbook of agile software craftsmanship. Learn to write code that is clean, readable, and maintainable.',
    price: 39.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=300&h=400&fit=crop',
    rating: 4.5,
    pageCount: 464,
    publishedYear: 2008,
  },
  {
    title: 'The Great Gatsby',
    author: 'F. Scott Fitzgerald',
    isbn: '978-0743273565',
    genre: 'Fiction',
    description: 'The story of the mysteriously wealthy Jay Gatsby and his love for the beautiful Daisy Buchanan, set in the Jazz Age.',
    price: 9.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1543002588-bfa74002ed7e?w=300&h=400&fit=crop',
    rating: 4.0,
    pageCount: 180,
    publishedYear: 1925,
  },
  {
    title: 'The Girl with the Dragon Tattoo',
    author: 'Stieg Larsson',
    isbn: '978-0307454546',
    genre: 'Mystery',
    description: 'A journalist and a hacker investigate a decades-old disappearance case in this gripping Scandinavian thriller.',
    price: 12.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1509021436665-8f07dbf5bf1d?w=300&h=400&fit=crop',
    rating: 4.3,
    pageCount: 672,
    publishedYear: 2005,
  },
  {
    title: 'Thinking, Fast and Slow',
    author: 'Daniel Kahneman',
    isbn: '978-0374533557',
    genre: 'Non-Fiction',
    description: 'Nobel laureate Daniel Kahneman takes us on a groundbreaking tour of the mind and explains the two systems that drive the way we think.',
    price: 15.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=300&h=400&fit=crop',
    rating: 4.4,
    pageCount: 512,
    publishedYear: 2011,
  },
  {
    title: 'The Alchemist',
    author: 'Paulo Coelho',
    isbn: '978-0062315007',
    genre: 'Fiction',
    description: 'A magical story about following your dreams and listening to your heart. An Andalusian shepherd boy journeys to the Egyptian pyramids.',
    price: 11.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1512820790803-83ca734da794?w=300&h=400&fit=crop',
    rating: 4.2,
    pageCount: 208,
    publishedYear: 1988,
  },
  {
    title: 'The Martian',
    author: 'Andy Weir',
    isbn: '978-0553418026',
    genre: 'Science Fiction',
    description: 'Stranded on Mars by a dust storm, astronaut Mark Watney must figure out how to survive with limited supplies.',
    price: 13.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1614728894747-a83421e2b9c9?w=300&h=400&fit=crop',
    rating: 4.6,
    pageCount: 384,
    publishedYear: 2014,
  },
  {
    title: 'Pride and Prejudice',
    author: 'Jane Austen',
    isbn: '978-0141439518',
    genre: 'Romance',
    description: 'The story of Elizabeth Bennet and Mr. Darcy navigating society, reputation, and their own pride and prejudices.',
    price: 8.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1476275466078-4007374efbbe?w=300&h=400&fit=crop',
    rating: 4.5,
    pageCount: 432,
    publishedYear: 1813,
  },
  {
    title: 'Designing Data-Intensive Applications',
    author: 'Martin Kleppmann',
    isbn: '978-1449373320',
    genre: 'Technology',
    description: 'The big ideas behind reliable, scalable, and maintainable systems. A must-read for software engineers.',
    price: 44.99,
    coverImageUrl: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=300&h=400&fit=crop',
    rating: 4.8,
    pageCount: 616,
    publishedYear: 2017,
  },
  {
    title: 'The Power of Habit',
    author: 'Charles Duhigg',
    isbn: '978-0812981605',
    genre: 'Self-Help',
    description: 'Why we do what we do in life and business. Explores the science behind habit creation and reformation.',
    price: 14.49,
    coverImageUrl: 'https://images.unsplash.com/photo-1434030216411-0b793f4b4173?w=300&h=400&fit=crop',
    rating: 4.3,
    pageCount: 400,
    publishedYear: 2012,
  },
];

async function seed() {
  console.log(`Seeding ${sampleBooks.length} books into ${TABLE_NAME}...`);

  // Prepare items with generated IDs and timestamps
  const items = sampleBooks.map((book) => ({
    bookId: randomUUID(),
    ...book,
    createdAt: new Date().toISOString(),
  }));

  // DynamoDB BatchWrite supports max 25 items per batch
  const batches = [];
  for (let i = 0; i < items.length; i += 25) {
    batches.push(items.slice(i, i + 25));
  }

  for (const batch of batches) {
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: batch.map((item) => ({
            PutRequest: { Item: item },
          })),
        },
      })
    );
    console.log(`  Written batch of ${batch.length} items`);
  }

  console.log('✓ Seeding complete!');
}

seed().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
