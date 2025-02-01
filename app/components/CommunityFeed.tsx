"use client"

import { useState, useEffect } from 'react'
import { db } from '../firebase'
import { collection, addDoc, query, orderBy, onSnapshot, Timestamp } from 'firebase/firestore'

interface Post {
  id: string
  content: string
  author: string
  timestamp: Timestamp
}

export default function CommunityFeed() {
  const [posts, setPosts] = useState<Post[]>([])
  const [newPost, setNewPost] = useState('')
  const [author, setAuthor] = useState('')

  useEffect(() => {
    // Firestore에서 실시간으로 포스트 가져오기
    const q = query(collection(db, 'posts'), orderBy('timestamp', 'desc'))
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const newPosts = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Post[]
      setPosts(newPosts)
    })

    return () => unsubscribe()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newPost.trim() || !author.trim()) return

    try {
      await addDoc(collection(db, 'posts'), {
        content: newPost,
        author: author,
        timestamp: Timestamp.now()
      })
      
      setNewPost('')
    } catch (error) {
      console.error('포스트 작성 중 오류 발생:', error)
    }
  }

  return (
    <div className="bg-gray-800 p-4 rounded-lg">
      <h2 className="text-xl font-bold text-white mb-4">커뮤니티 피드</h2>
      
      {/* 포스트 작성 폼 */}
      <form onSubmit={handleSubmit} className="mb-6">
        <div className="mb-4">
          <input
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="작성자 이름"
            className="w-full p-2 rounded bg-gray-700 text-white placeholder-gray-400 mb-2"
            required
          />
          <textarea
            value={newPost}
            onChange={(e) => setNewPost(e.target.value)}
            placeholder="무슨 생각을 하고 계신가요?"
            className="w-full p-2 rounded bg-gray-700 text-white placeholder-gray-400"
            rows={3}
            required
          />
        </div>
        <button
          type="submit"
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition-colors"
        >
          게시하기
        </button>
      </form>

      {/* 포스트 목록 */}
      <div className="space-y-4">
        {posts.map((post) => (
          <div key={post.id} className="bg-gray-700 p-4 rounded-lg">
            <div className="flex justify-between items-start mb-2">
              <span className="font-bold text-white">{post.author}</span>
              <span className="text-sm text-gray-400">
                {post.timestamp.toDate().toLocaleString()}
              </span>
            </div>
            <p className="text-gray-200 whitespace-pre-wrap">{post.content}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

