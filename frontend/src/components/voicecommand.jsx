'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Mic, MicOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'react-hot-toast';
import { Badge } from '@/components/ui/badge';

export default function VoiceCommander() {
  const router = useRouter();
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [supported, setSupported] = useState(true);
  
  // Use a ref to persist the recognition instance
  const recognitionRef = useRef(null);

  useEffect(() => {
    // Check for browser support only once during component mount
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setSupported(false);
      toast.error("Your browser doesn't support voice commands. Try Chrome or Edge.");
      return;
    }

    // Initialize recognition only if not already created
    if (!recognitionRef.current) {
      const recognitionInstance = new SpeechRecognition();
      recognitionInstance.lang = 'en-US';
      recognitionInstance.continuous = true;
      recognitionInstance.interimResults = true;

      recognitionInstance.onstart = () => {
        setIsListening(true);
        toast.success("Voice Commands Active. Try saying: 'search song [title]', 'play audio', 'pause audio'");
      };

      recognitionInstance.onend = () => {
        setIsListening(false);
        // If we were expecting to be listening but recognition stopped, restart it
        if (recognitionRef.current.restartOnEnd) {
          try {
            recognitionRef.current.restartOnEnd = false;
            setTimeout(() => {
              if (recognitionRef.current) {
                recognitionRef.current.start();
              }
            }, 500);
          } catch (e) {
            console.error('Failed to restart recognition', e);
          }
        }
      };

      recognitionInstance.onerror = (event) => {
        console.error('Speech recognition error', event.error);
        setIsListening(false);

        if (event.error === 'not-allowed') {
          toast.error("Microphone Access Denied. Please allow microphone access to use voice commands.");
        } else if (event.error === 'aborted') {
          // Ignore aborted errors as they're expected when manually stopping
        } else {
          toast.error(`Voice Recognition Error: ${event.error}. Please try again.`);
        }
      };

      recognitionInstance.onresult = (event) => {
        const current = event.resultIndex;
        const result = event.results[current][0].transcript.trim().toLowerCase();
        setTranscript(result);

        if (event.results[current].isFinal) {
          handleCommand(result);
        }
      };

      recognitionRef.current = recognitionInstance;
      recognitionRef.current.restartOnEnd = false;
    }

    // Cleanup on component unmount
    return () => {
      try {
        if (recognitionRef.current && isListening) {
          recognitionRef.current.restartOnEnd = false;
          recognitionRef.current.stop();
        }
      } catch (e) {
        console.error('Error stopping recognition on unmount', e);
      }
    };
  }, []);

  const toggleListening = () => {
    if (!recognitionRef.current) return;
    
    try {
      if (isListening) {
        recognitionRef.current.restartOnEnd = false;
        recognitionRef.current.stop();
        setTranscript('');
      } else {
        recognitionRef.current.restartOnEnd = true;
        recognitionRef.current.start();
      }
    } catch (err) {
      console.error('Recognition toggle error:', err);
      
      // Handle the case where recognition is already started
      if (err.message.includes('already started')) {
        recognitionRef.current.stop();
        setTimeout(() => {
          if (recognitionRef.current) {
            recognitionRef.current.start();
          }
        }, 500);
      }
    }
  };

  const handleCommand = (command) => {
    console.log('🗣️ Command detected:', command);

    const audioPlayer = document.getElementById('audioPlayer');
    
    // Handle song search commands
    if (command.includes('search song') || command.includes('search for') || command.includes('find song')) {
      const searchRegex = /search (?:song|for)|find song/gi;
      const searchTerms = command.replace(searchRegex, '').trim();
      
      if (searchTerms) {
        const searchInput = document.getElementById('songSearchInput');
        if (searchInput) {
          // Set the value and trigger input event
          searchInput.value = searchTerms;
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          
          // Find and click the search button
          const searchButton = searchInput.nextElementSibling;
          if (searchButton) {
            setTimeout(() => searchButton.click(), 100);
            toast.success(`Searching for "${searchTerms}"`);
          }
        }
      } else {
        toast.error("Please specify what to search for");
      }
    } 
    // Handle audio playback commands
    else if (command.match(/\b(play|start)\b/) && !command.includes('playlist')) {
      if (audioPlayer) {
        audioPlayer.play().catch(err => {
          console.error('Play error:', err);
          toast.error("Couldn't play audio. Try selecting a song first.");
        });
        toast.success("Playing audio");
      } else {
        toast.error("No audio loaded. Search and select a song first.");
      }
    } 
    else if (command.match(/\b(pause|stop)\b/) && !command.includes('playlist')) {
      if (audioPlayer) {
        audioPlayer.pause();
        toast.success("Paused audio");
      } else {
        toast.error("No audio is currently playing");
      }
    } 
    // Handle navigation commands
    else if (command.includes('go to playlist') || command.includes('show playlist') || command.includes('open playlists')) {
      const playlistsTab = document.querySelector('[value="playlists"]');
      if (playlistsTab) {
        playlistsTab.click();
        toast.success("Showing playlists");
      }
    } 
    else if (command.includes('go to search') || command.includes('show search') || command.includes('open search')) {
      const searchTab = document.querySelector('[value="search"]');
      if (searchTab) {
        searchTab.click();
        toast.success("Showing search");
      }
    } 
    // Handle volume commands
    else if (command.includes('volume up') || command.includes('louder') || command.includes('increase volume')) {
      if (audioPlayer) {
        const newVolume = Math.min(1, audioPlayer.volume + 0.1);
        audioPlayer.volume = newVolume;
        toast.success(`Volume: ${Math.round(newVolume * 100)}%`);
      }
    } 
    else if (command.includes('volume down') || command.includes('quieter') || command.includes('decrease volume') || command.includes('lower volume')) {
      if (audioPlayer) {
        const newVolume = Math.max(0, audioPlayer.volume - 0.1);
        audioPlayer.volume = newVolume;
        toast.success(`Volume: ${Math.round(newVolume * 100)}%`);
      }
    } 
    else if (command.includes('mute') || command.includes('silence')) {
      if (audioPlayer) {
        audioPlayer.volume = 0;
        toast.success("Audio muted");
      }
    }
    // Handle scrolling commands
    else if (command.includes('scroll down')) {
      window.scrollBy({ top: 300, behavior: 'smooth' });
    } 
    else if (command.includes('scroll up')) {
      window.scrollBy({ top: -300, behavior: 'smooth' });
    }
    // Play playlist command
    else if ((command.includes('play playlist') || command.includes('start playlist')) && command.length > 14) {
      const playlistName = command.replace(/play playlist|start playlist/gi, '').trim();
      if (playlistName) {
        // Find playlist elements that contain the requested name
        const playlistElements = Array.from(document.querySelectorAll('.card-title')).filter(el => 
          el.textContent.toLowerCase().includes(playlistName.toLowerCase())
        );
        
        if (playlistElements.length > 0) {
          // Find the play button within the closest card
          const playButton = playlistElements[0].closest('.card')?.querySelector('button');
          if (playButton) {
            playButton.click();
            toast.success(`Playing playlist "${playlistElements[0].textContent}"`);
          }
        } else {
          toast.error(`Couldn't find playlist "${playlistName}"`);
        }
      }
    }
    // Help command
    else if (command.includes('what can i say') || command.includes('voice commands') || command.includes('help')) {
      toast.success("Available commands: search for [song], play, pause, volume up/down, mute, go to playlists/search, play playlist [name]");
    }
  };

  if (!supported) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex flex-col items-start gap-2">
      {transcript && isListening && (
        <Badge variant="outline" className="bg-white/90 dark:bg-slate-800/90 shadow-md max-w-[200px] truncate">
          {transcript}
        </Badge>
      )}
      <Button
        onClick={toggleListening}
        size="icon"
        className={`rounded-full h-12 w-12 shadow-lg ${
          isListening
            ? 'bg-red-500 hover:bg-red-600 text-white'
            : 'bg-purple-600 hover:bg-purple-700 text-white'
        }`}
        aria-label={isListening ? "Stop voice commands" : "Start voice commands"}
      >
        {isListening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
      </Button>
    </div>
  );
}