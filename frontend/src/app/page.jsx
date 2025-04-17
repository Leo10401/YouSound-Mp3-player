"use client"

import { useEffect, useState, useRef } from "react"
import axios from "axios"
import { Search, Play, Download, Plus, Trash2, Music, ListMusic, PlusCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Slider } from "@/components/ui/slider"
import VoiceCommander from "@/components/voicecommand"
import { toast } from "react-hot-toast"

const YT_API_KEY = process.env.NEXT_PUBLIC_YT_API_KEY
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL

function CustomAudioPlayer({ src, onEnded, autoPlay }) {
  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(autoPlay)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [volume, setVolume] = useState(1)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const updateTime = () => setCurrentTime(audio.currentTime)
    const updateDuration = () => setDuration(audio.duration)
    const handleEnded = () => {
      setPlaying(false)
      if (onEnded) onEnded()
    }

    audio.addEventListener("timeupdate", updateTime)
    audio.addEventListener("durationchange", updateDuration)
    audio.addEventListener("ended", handleEnded)

    return () => {
      audio.removeEventListener("timeupdate", updateTime)
      audio.removeEventListener("durationchange", updateDuration)
      audio.removeEventListener("ended", handleEnded)
    }
  }, [onEnded])

  useEffect(() => {
    if (autoPlay) {
      audioRef.current?.play().catch((e) => console.error("Autoplay failed:", e))
    }
  }, [src, autoPlay])

  const togglePlay = () => {
    if (playing) {
      audioRef.current.pause()
    } else {
      audioRef.current.play()
    }
    setPlaying(!playing)
  }

  const handleProgressChange = (value) => {
    const newTime = value[0]
    if (audioRef.current) {
      audioRef.current.currentTime = newTime
      setCurrentTime(newTime) // Order matters here, set the actual audio time first
    }
  }

  const handleVolumeChange = (value) => {
    const newVolume = value[0]
    setVolume(newVolume)
    if (audioRef.current) {
      audioRef.current.volume = newVolume
    }
  }

  const formatTime = (time) => {
    const minutes = Math.floor(time / 60)
    const seconds = Math.floor(time % 60)
    return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`
  }

  return (
    <div className="space-y-2">
      <audio id="audioPlayer" ref={audioRef} src={src} className="hidden" autoPlay={autoPlay} />

      <div className="flex items-center gap-4">
        <Button onClick={togglePlay} variant="outline" size="icon" className="h-10 w-10 rounded-full">
          {playing ? (
            <div className="w-3 h-3 border-l-2 border-r-2 border-current"></div>
          ) : (
            <Play className="h-4 w-4" />
          )}
        </Button>

        <div className="flex items-center gap-2 w-32">
          <Button
            onClick={() => handleVolumeChange([volume === 0 ? 1 : 0])}
            variant="ghost"
            size="icon"
            className="h-8 w-8"
          >
            {volume === 0 ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <line x1="23" y1="9" x2="17" y2="15"></line>
                <line x1="17" y1="9" x2="23" y2="15"></line>
              </svg>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
              </svg>
            )}
          </Button>
          <Slider
            value={[volume]}
            min={0}
            max={1}
            step={0.01}
            onValueChange={handleVolumeChange}
            className="cursor-pointer"
          />
        </div>
      </div>
      <div className="flex items-center justify-between mt-2">
        <div className="text-sm text-slate-500 dark:text-slate-400 w-16">{formatTime(currentTime)}</div>

        <Slider
          value={[currentTime]}
          min={0}
          max={duration || 100}
          step={0.1}
          onValueChange={handleProgressChange}
          className="cursor-pointer"
        />

        <div className="text-sm text-slate-500 dark:text-slate-400 w-16 text-right">{formatTime(duration)}</div>
      </div>
    </div>
  )
}

export default function Home() {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState([])
  const [currentVideo, setCurrentVideo] = useState(null)
  const [history, setHistory] = useState([])
  const [autoplayNext, setAutoplayNext] = useState(true)

  // Playlist states
  const [playlists, setPlaylists] = useState({})
  const [currentPlaylist, setCurrentPlaylist] = useState(null)
  const [playlistName, setPlaylistName] = useState("")
  const [showPlaylistModal, setShowPlaylistModal] = useState(false)
  const [activeTab, setActiveTab] = useState("search")
  const [playingFrom, setPlayingFrom] = useState(null); // 'search' or 'playlist'

  useEffect(() => {
    const stored = localStorage.getItem("search-history")
    if (stored) setHistory(JSON.parse(stored))

    // Load playlists from localStorage
    const storedPlaylists = localStorage.getItem("music-playlists")
    if (storedPlaylists) setPlaylists(JSON.parse(storedPlaylists))
  }, [])

  const updateHistory = (term) => {
    const updated = [term, ...history.filter((q) => q !== term)].slice(0, 10)
    setHistory(updated)
    localStorage.setItem("search-history", JSON.stringify(updated))
  }

  const searchYouTube = async () => {
    if (!query.trim()) return

    try {
      const res = await axios.get(`https://www.googleapis.com/youtube/v3/search`, {
        params: {
          part: "snippet",
          q: query,
          type: "video",
          videoCategoryId: "10", // Music category only
          key: YT_API_KEY,
          maxResults: 10,
        },
      })
      setResults(res.data.items)
      updateHistory(query)
    } catch (err) {
      console.error(err)
      toast.error("Could not complete your search. Please check your API key.")
    }
  }

  const playAudio = (video, source = 'search') => {
    setCurrentVideo(video);
    setPlayingFrom(source);
  };

  const downloadAudio = () => {
    if (!currentVideo) return
    const url = `${BACKEND_URL}/audio/${currentVideo.id.videoId}`
    const link = document.createElement("a")
    link.href = url
    link.download = `${currentVideo.snippet.title}.mp3`
    link.click()
  }

  // Playlist functions
  const createPlaylist = () => {
    if (!playlistName.trim()) return

    const newPlaylists = {
      ...playlists,
      [playlistName]: [],
    }

    setPlaylists(newPlaylists)
    localStorage.setItem("music-playlists", JSON.stringify(newPlaylists))
    setPlaylistName("")
    setShowPlaylistModal(false)
    toast.success(`"${playlistName}" has been created.`)
  }

  const deletePlaylist = (name) => {
    const { [name]: _, ...remaining } = playlists
    setPlaylists(remaining)
    localStorage.setItem("music-playlists", JSON.stringify(remaining))

    if (currentPlaylist === name) {
      setCurrentPlaylist(null)
    }

    toast.success(`"${name}" has been deleted.`)
  }

  const addToPlaylist = (playlistName, video) => {
    if (playlists[playlistName].some((v) => v.id.videoId === video.id.videoId)) {
      toast.error("This song is already in the playlist.")
      return
    }

    const updatedPlaylists = {
      ...playlists,
      [playlistName]: [...playlists[playlistName], video],
    }

    setPlaylists(updatedPlaylists)
    localStorage.setItem("music-playlists", JSON.stringify(updatedPlaylists))
    toast.success(`Song added to "${playlistName}".`)
  }

  const removeFromPlaylist = (playlistName, videoId) => {
    const updatedPlaylist = playlists[playlistName].filter((video) => video.id.videoId !== videoId)

    const updatedPlaylists = {
      ...playlists,
      [playlistName]: updatedPlaylist,
    }

    setPlaylists(updatedPlaylists)
    localStorage.setItem("music-playlists", JSON.stringify(updatedPlaylists))
  }

  const playPlaylist = (playlistName) => {
    setCurrentPlaylist(playlistName);
    if (playlists[playlistName].length > 0) {
      playAudio(playlists[playlistName][0], 'playlist');
      toast.success(`Now playing "${playlistName}"`);
    }
  };

  const playNextInPlaylist = () => {
    if (!currentPlaylist || !currentVideo) return null;

    const currentIndex = playlists[currentPlaylist].findIndex((v) => v.id.videoId === currentVideo.id.videoId);
    const nextIndex = currentIndex + 1;

    if (nextIndex < playlists[currentPlaylist].length) {
      const nextVideo = playlists[currentPlaylist][nextIndex];
      setPlayingFrom('playlist');
      return nextVideo;
    }
    return null;
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 p-4 md:p-6">
      <div className="max-w-3xl mx-auto">
        <VoiceCommander />
        <header className="mb-8 text-center">
          <h1 className="text-4xl font-bold mb-2 bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">
          YouSound
          </h1>
          <p className="text-slate-600 dark:text-slate-400">Your personal music streaming experience</p>
        </header>

        {/* Main Content */}
        <div className="bg-white dark:bg-slate-950 rounded-xl shadow-xl overflow-hidden mb-20">
          {/* Tabs Navigation */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="w-full grid grid-cols-2 rounded-none">
              <TabsTrigger
                value="search"
                className="data-[state=active]:bg-slate-100 dark:data-[state=active]:bg-slate-800"
              >
                <Search className="w-4 h-4 mr-2" />
                Search
              </TabsTrigger>
              <TabsTrigger
                value="playlists"
                className="data-[state=active]:bg-slate-100 dark:data-[state=active]:bg-slate-800"
              >
                <ListMusic className="w-4 h-4 mr-2" />
                Playlists
              </TabsTrigger>
            </TabsList>

            {/* Search Tab */}
            <TabsContent value="search" className="p-4 md:p-6 space-y-6">
              <div className="flex gap-1 md:gap-2">
                <Input
                  type="text"
                  id="songSearchInput"
                  placeholder="Search for music..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && searchYouTube()}
                  className="flex-1 text-sm md:text-base h-9 md:h-10"
                />
                <Button onClick={searchYouTube} variant="default" className="h-9 md:h-10">
                  <Search className="w-4 h-4 mr-0 md:mr-2" />
                  <span className="hidden md:inline">Search</span>
                </Button>
              </div>

              {history.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium mb-2 text-slate-500 dark:text-slate-400">Recent Searches</h3>
                  <div className="flex flex-wrap gap-2">
                    {history.map((h, idx) => (
                      <Badge
                        key={idx}
                        variant="secondary"
                        className="cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700"
                        onClick={() => {
                          setQuery(h)
                          searchYouTube()
                        }}
                      >
                        {h}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {results.length > 0 ? (
                <ScrollArea className="h-[400px] pr-4">
                  <div className="space-y-3">
                    {results.map((video) => (
                      <Card key={video.id.videoId} className="overflow-hidden">
                        <div className="flex">
                          <img
                            src={video.snippet.thumbnails.default.url || "/placeholder.svg"}
                            alt=""
                            className="h-full w-24 object-cover"
                          />
                          <div className="p-3 flex-1">
                            <h3 className="font-medium line-clamp-2">{video.snippet.title}</h3>
                            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                              {video.snippet.channelTitle}
                            </p>

                            <div className="flex gap-2 mt-3">
                              <Button size="sm" onClick={() => playAudio(video)} className="gap-1">
                                <Play className="w-3 h-3" />
                                Play
                              </Button>

                              {Object.keys(playlists).length > 0 && (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button size="sm" variant="outline" className="gap-1">
                                      <Plus className="w-3 h-3" />
                                      Add to Playlist
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="z-50">
                                    {Object.keys(playlists).map((name) => (
                                      <DropdownMenuItem key={name} onClick={() => addToPlaylist(name, video)}>
                                        {name}
                                      </DropdownMenuItem>
                                    ))}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              )}
                            </div>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <div className="text-center py-12">
                  <Music className="w-12 h-12 mx-auto text-slate-300 dark:text-slate-700 mb-3" />
                  <p className="text-slate-500 dark:text-slate-400">
                    {query ? "No results found. Try a different search." : "Search for your favorite music"}
                  </p>
                </div>
              )}
            </TabsContent>

            {/* Playlists Tab */}
            <TabsContent value="playlists" className="p-4 md:p-6 space-y-6">
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-semibold">My Playlists</h2>
                <Button
                  onClick={() => setShowPlaylistModal(true)}
                  size="sm"
                  className="gap-1 h-8 md:h-9 text-xs md:text-sm"
                >
                  <PlusCircle className="w-3 h-3 md:w-4 md:h-4" />
                  <span className="hidden xs:inline">New Playlist</span>
                  <span className="xs:hidden">New</span>
                </Button>
              </div>

              {Object.keys(playlists).length === 0 ? (
                <div className="text-center py-12">
                  <ListMusic className="w-12 h-12 mx-auto text-slate-300 dark:text-slate-700 mb-3" />
                  <p className="text-slate-500 dark:text-slate-400">No playlists yet. Create one to get started!</p>
                </div>
              ) : (
                <ScrollArea className="h-[400px] pr-4">
                  <div className="space-y-4">
                    {Object.entries(playlists).map(([name, videos]) => (
                      <Card key={name}>
                        <CardHeader className="pb-2">
                          <div className="flex justify-between items-center">
                            <CardTitle className="text-lg">{name}</CardTitle>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="default"
                                onClick={() => playPlaylist(name)}
                                className="gap-1"
                                disabled={videos.length === 0}
                              >
                                <Play className="w-3 h-3" />
                                Play
                              </Button>
                              <Button size="sm" variant="destructive" onClick={() => deletePlaylist(name)}>
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="pt-0">
                          {videos.length === 0 ? (
                            <p className="text-sm text-slate-500 dark:text-slate-400 py-2">This playlist is empty</p>
                          ) : (
                            <div className="space-y-2">
                              {videos.map((video) => (
                                <div key={video.id.videoId} className="flex items-center gap-2 py-2 group">
                                  <img
                                    src={video.snippet.thumbnails.default.url || "/placeholder.svg"}
                                    alt=""
                                    className="w-12 h-9 rounded object-cover"
                                  />
                                  <div className="flex-1 min-w-0">
                                    <p className="truncate text-sm">{video.snippet.title}</p>
                                  </div>
                                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="h-8 w-8"
                                      onClick={() => playAudio(video)}
                                    >
                                      <Play className="w-3 h-3" />
                                    </Button>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                                      onClick={() => removeFromPlaylist(name, video.id.videoId)}
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </TabsContent>
          </Tabs>

          {/* Now Playing Section */}
          {currentVideo && (
            <div
              className="border-t dark:border-slate-800 bg-white dark:bg-slate-950 w-96 flex justify-end"
              style={{
                position: "fixed",
                bottom: 0,
                right: 0,
                zIndex: 1000,
                padding: "8px 0",
                boxShadow: "0 -2px 8px rgba(0,0,0,0.2)",
              }}
            >
              <Card className="rounded-none border-0 shadow-none ">
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-center">
                    <CardTitle className="text-lg">Now Playing</CardTitle>
                    {currentPlaylist && (
                      <Badge variant="outline" className="gap-1">
                        <ListMusic className="w-3 h-3" />
                        {currentPlaylist}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-4 items-center mb-4 ">
                    <img
                      src={currentVideo.snippet.thumbnails.medium.url || "/placeholder.svg"}
                      alt=""
                      className="rounded-md w-24 h-24 object-cover"
                    />
                    <div>
                      <h3 className="font-medium line-clamp-2">{currentVideo.snippet.title}</h3>
                      <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        {currentVideo.snippet.channelTitle}
                      </p>
                    </div>
                  </div>

                  <CustomAudioPlayer
                    src={`${BACKEND_URL}/audio/${currentVideo.id.videoId}`}
                    onEnded={() => {
                      if (!autoplayNext) return

                      // Check if playing from a playlist
                      if (currentPlaylist) {
                        const next = playNextInPlaylist()
                        if (next) setCurrentVideo(next)
                        return
                      }

                      // Otherwise use search results for autoplay
                      const currentIndex = results.findIndex((v) => v.id.videoId === currentVideo.id.videoId)
                      const next = results[currentIndex + 1]
                      if (next) setCurrentVideo(next)
                    }}
                    autoPlay={true}
                  />

                  <div className="flex items-center justify-between mt-4">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="autoplay"
                        checked={autoplayNext}
                        onCheckedChange={() => setAutoplayNext(!autoplayNext)}
                      />
                      <label htmlFor="autoplay" className="text-sm cursor-pointer">
                        Autoplay next
                      </label>
                    </div>

                    <div className="flex gap-2">
                      <Button onClick={downloadAudio} variant="outline" className="gap-1">
                        <Download className="w-4 h-4" />
                        Download
                      </Button>

                      {Object.keys(playlists).length > 0 && playingFrom === 'search' && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="outline" className="gap-1">
                              <Plus className="w-4 h-4" />
                              Add to Playlist
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="z-[1001]">
                            {Object.keys(playlists).map((name) => (
                              <DropdownMenuItem key={name} onClick={() => addToPlaylist(name, currentVideo)}>
                                {name}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        {/* New Playlist Modal */}
        <Dialog open={showPlaylistModal} onOpenChange={setShowPlaylistModal}>
          <DialogContent className="sm:max-w-md max-w-[90vw]">
            <DialogHeader>
              <DialogTitle>Create New Playlist</DialogTitle>
            </DialogHeader>
            <Input
              type="text"
              placeholder="Playlist name"
              value={playlistName}
              onChange={(e) => setPlaylistName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createPlaylist()}
              className="mt-4"
            />
            <DialogFooter className="mt-4 flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={() => setShowPlaylistModal(false)} className="sm:w-auto w-full">
                Cancel
              </Button>
              <Button onClick={createPlaylist} disabled={!playlistName.trim()} className="sm:w-auto w-full">
                Create Playlist
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </main>
  )
}
