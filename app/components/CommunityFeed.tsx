/* eslint-disable @typescript-eslint/no-unused-vars */
"use client"
import { useState, useEffect } from 'react'
import { db } from '../firebase'
import { collection, addDoc, query, orderBy, onSnapshot, Timestamp, limit, getDocs, startAfter, QueryDocumentSnapshot, DocumentData } from 'firebase/firestore'

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
  const [lastVisible, setLastVisible] = useState<QueryDocumentSnapshot<DocumentData> | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    const savedAuthor = localStorage.getItem('communityAuthor')
    if (savedAuthor) {
      setAuthor(savedAuthor)
    }
    // 초기 데이터 로드
    loadInitialPosts()
  }, [])

  const loadInitialPosts = async () => {
    const q = query(
      collection(db, 'posts'),
      orderBy('timestamp', 'desc'),
      limit(10)
    )
    
    const snapshot = await getDocs(q)
    const posts = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as Post[]

    setPosts(posts)
    setLastVisible(snapshot.docs[snapshot.docs.length - 1])
    setHasMore(snapshot.docs.length === 10)
  }

  const loadMorePosts = async () => {
    if (!hasMore || isLoading || !lastVisible) return

    setIsLoading(true)
    try {
      const q = query(
        collection(db, 'posts'),
        orderBy('timestamp', 'desc'),
        startAfter(lastVisible),
        limit(10)
      )

      const snapshot = await getDocs(q)
      const newPosts = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Post[]

      setPosts(prev => [...prev, ...newPosts])
      setLastVisible(snapshot.docs[snapshot.docs.length - 1])
      setHasMore(snapshot.docs.length === 10 && posts.length < 50)
    } catch (error) {
      console.error('추가 포스트 로딩 중 오류 발생:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget
    if (scrollHeight - scrollTop <= clientHeight * 1.5) {
      loadMorePosts()
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newPost.trim() || !author.trim()) return

    try {
      localStorage.setItem('communityAuthor', author)

      await addDoc(collection(db, 'posts'), {
        content: newPost,
        author: author,
        timestamp: Timestamp.now()
      })
      
      setNewPost('')
      // 새 포스트 작성 후 목록 새로고침
      loadInitialPosts()
    } catch (error) {
      console.error('포스트 작성 중 오류 발생:', error)
    }
  }

  return (
    <div className="bg-gray-800 p-4 rounded-lg h-full flex flex-col">
      <h2 className="text-xl font-bold text-white mb-4">커뮤니티 피드</h2>
      
      {/* 포스트 작성 폼 */}
      <form onSubmit={handleSubmit} className="mb-4">
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

      {/* 포스트 목록 - 스크롤 가능한 컨테이너 */}
      <div 
        className="flex-1 overflow-y-auto"
        onScroll={handleScroll}
      >
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
          {isLoading && (
            <div className="text-center py-4">
              <p className="text-gray-400">로딩 중...</p>
            </div>
          )}
          {!hasMore && posts.length >= 50 && (
            <div className="text-center py-4">
              <p className="text-gray-400">더 이상 표시할 게시글이 없습니다</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

